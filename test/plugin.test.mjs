import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import plugin from "../index.mjs";

const TOKEN = "synthetic-session";
const ORG = "org-synthetic";
const EXPIRY = "2033-05-18T03:33:20.000Z";
const inputs = { sessionBearer: `  Bearer ${TOKEN}  `, organization: ORG };
const grant = { grant_amount: 50, used_amount: 10, effective_at: 1, expires_at: 2_000_000_000 };
const summary = {
  object: "credit_summary",
  total_available: 40,
  total_granted: 800,
  total_used: 100,
  total_paid_available: 0,
  grants: {
    data: [
      grant,
      { ...grant, expires_at: 50 },
      { ...grant, used_amount: 50, expires_at: null },
      { ...grant, is_scheduled: true },
      { ...grant, is_held_for_prepaid_transition: true },
      { ...grant, effective_at: 4_000_000_000, expires_at: null },
    ],
  },
};

test("Magpie sign-in and quota use the real Credit Grants response shape", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "magpie-credit-test-"));
  const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const previousHome = process.env[homeVar];
  process.env[homeVar] = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env[homeVar];
    else process.env[homeVar] = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  const credentialsPath = join(home, ".magpie-openai-api-credit.json");
  const { config, auth } = await plugin.server();
  const openai = { options: { apiKey: "model-api-key" }, models: { "gpt-test": {} } };
  const configuration = { provider: { openai } };
  await config(configuration);
  assert.deepEqual(configuration.provider.openai, openai);
  assert.deepEqual(configuration.provider[auth.provider].models, {});
  assert.deepEqual(await auth.loader(), {});
  const [method] = auth.methods;
  assert.deepEqual(method.prompts.map((prompt) => prompt.type), ["password", "password"]);

  let requests = 0;
  let response = () => Response.json(summary);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests++;
    assert.equal(url, "https://api.openai.com/v1/dashboard/billing/credit_grants");
    assert.deepEqual(options.headers, {
      Authorization: `Bearer ${TOKEN}`,
      "OpenAI-Organization": ORG,
      Accept: "application/json",
    });
    assert.equal(options.redirect, "error");
    assert.equal(options.proxy, "");
    assert.ok(options.signal instanceof AbortSignal);
    return response();
  });

  assert.equal((await method.authorize({ ...inputs, sessionBearer: "sk-not-a-session" })).type, "failed");
  assert.equal((await method.authorize({ ...inputs, organization: "org-test\r\nX-Injected: yes" })).type, "failed");
  assert.equal(requests, 0);
  const signin = await method.authorize(inputs);
  assert.equal(signin.method, "auto");
  const result = await signin.callback();
  assert.equal(result.type, "success");
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes(ORG));
  assert.deepEqual(JSON.parse(await readFile(credentialsPath, "utf8")), { sessionBearer: TOKEN, organization: ORG });
  if (process.platform !== "win32") assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);

  const getAuth = async () => ({ type: "api", key: result.key });
  assert.deepEqual(await auth.usage(getAuth), {
    balance: "$40.00",
    windows: [{
      name: "Next credit expiry",
      aside: true,
      display: "$40.00 · 2033-05-18 03:33 UTC",
      runsOutAt: EXPIRY,
      runsOut: 40,
      unit: "USD",
    }],
  });

  response = () => Response.json({ ...summary, total_available: 12.34, total_paid_available: 4 });
  const paid = await auth.usage(getAuth);
  assert.equal(paid.balance, "$12.34");
  assert.equal(paid.windows[0].runsOutAt, EXPIRY);
  assert.equal(paid.windows[0].runsOut, undefined);
  assert.equal(requests, 3);

  response = () => Response.json({ ...summary, total_available: 0, grants: { data: [] } });
  assert.deepEqual(await auth.usage(getAuth), { balance: "$0.00", windows: [] });

  for (const status of [401, 403, 429, 500]) {
    response = () => new Response(`${TOKEN} ${ORG}`, { status });
    const quota = await auth.usage(getAuth);
    assert.equal(quota.signIn, [401, 403].includes(status) ? "expired" : "kept");
    assert.ok(quota.error);
    assert.ok(!quota.error.includes(TOKEN));
    assert.ok(!quota.error.includes(ORG));
    assert.equal(quota.balance, undefined);
  }
  response = () => Response.json({ ...summary, total_available: "40" });
  assert.match((await auth.usage(getAuth)).error, /invalid Credit Grants response/);
  assert.equal((await signin.callback()).type, "failed");
  assert.equal(JSON.parse(await readFile(credentialsPath, "utf8")).sessionBearer, TOKEN);

  await rm(credentialsPath);
  assert.equal((await auth.usage(getAuth)).signIn, "expired");
});
