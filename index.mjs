import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import creditGrants from "./balance.cjs";

const PROVIDER = "openai-api-credit";
const CREDIT_URL = "https://api.openai.com/v1/dashboard/billing/credit_grants";
const LOCAL_SIGN_IN = "local-platform-session";
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function credentialsOf(inputs) {
  if (typeof inputs?.sessionBearer !== "string" || typeof inputs?.organization !== "string") return;
  const sessionBearer = inputs.sessionBearer.trim().replace(/^Bearer\s+/i, "");
  const organization = inputs.organization.trim();
  if (!sessionBearer || !/^[\x21-\x7e]+$/.test(sessionBearer) || sessionBearer.startsWith("sk-")) return;
  if (!organization || !/^[A-Za-z0-9_-]+$/.test(organization)) return;
  return { sessionBearer, organization };
}

async function queryCredits({ sessionBearer, organization }, signal) {
  let response;
  try {
    const timeout = AbortSignal.timeout(15_000);
    response = await fetch(CREDIT_URL, {
      headers: {
        Authorization: `Bearer ${sessionBearer}`,
        "OpenAI-Organization": organization,
        Accept: "application/json",
      },
      redirect: "error",
      proxy: "", // Use Bun's direct transport for the Platform session.
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    return { error: "Could not reach OpenAI Platform billing.", signIn: "kept" };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      error: `OpenAI refused the Platform session (HTTP ${response.status}). Sign in again and verify the Organization ID.`,
      signIn: "expired",
    };
  }
  if (response.status === 429) {
    return { error: "OpenAI Platform billing is rate limited. Try again later.", signIn: "kept" };
  }
  if (response.status !== 200) {
    return { error: `OpenAI Platform billing is unavailable (HTTP ${response.status}).`, signIn: "kept" };
  }
  try {
    return { credit: creditGrants.parseBalance(await response.json()) };
  } catch {
    return { error: "OpenAI Platform returned an invalid Credit Grants response.", signIn: "kept" };
  }
}

function quotaOf({ available, expiresAt, usableGrants }) {
  // Magpie records a card's dollar balance history when it has no quota windows.
  const quota = { balance: USD.format(available), plan: "API credits", windows: [] };
  if (!expiresAt) return quota;

  const expiring = usableGrants
    .filter((grant) => grant.expiresAt === expiresAt)
    .reduce((total, grant) => total + grant.remaining, 0);
  return {
    ...quota,
    plan: expiring ? `Next credit expiry · ${USD.format(expiring)}` : "Next credit expiry",
    until: expiresAt,
    renew: "off",
  };
}

export default {
  id: "magpie-openai-api-credit",
  async server(_input, options) {
    const credentialsPath = join(homedir(), ".magpie-openai-api-credit.json");
    return {
      async config(config) {
        config.provider ??= {};
        config.provider[PROVIDER] ??= { name: "OpenAI API Credits", models: {} };
      },
      auth: {
        provider: PROVIDER,
        icon: typeof options?.icon === "string" ? options.icon : undefined,
        single: true,
        methods: [{
          type: "oauth",
          label: "Enter OpenAI Platform credentials",
          labels: { zh: "输入 OpenAI Platform 凭证" },
          prompts: [
            { type: "password", key: "sessionBearer", message: "OpenAI Platform Session Bearer Token" },
            { type: "password", key: "organization", message: "OpenAI Organization ID" },
          ],
          async authorize(inputs) {
            const credentials = credentialsOf(inputs);
            if (!credentials) {
              return { type: "failed", error: "Enter a Platform session bearer token and a valid Organization ID." };
            }
            return {
              method: "auto",
              async callback(_code, { signal } = {}) {
                const result = await queryCredits(credentials, signal);
                if (result.error) return { type: "failed", error: result.error };
                const temporaryPath = `${credentialsPath}.${randomUUID()}.tmp`;
                try {
                  await writeFile(temporaryPath, JSON.stringify(credentials), { mode: 0o600, flag: "wx", signal });
                  signal?.throwIfAborted();
                  await rename(temporaryPath, credentialsPath);
                } catch {
                  return { type: "failed", error: "Could not save the local OpenAI Platform credentials." };
                } finally {
                  await rm(temporaryPath, { force: true }).catch(() => {});
                }
                return { type: "success", key: LOCAL_SIGN_IN };
              },
            };
          },
        }],
        async loader() {
          return {};
        },
        async usage(getAuth, _provider, { signal } = {}) {
          let credentials;
          try {
            const auth = await getAuth();
            if (auth?.type === "api" && auth.key === LOCAL_SIGN_IN) {
              credentials = credentialsOf(JSON.parse(await readFile(credentialsPath, "utf8")));
            }
          } catch {
            // A sign-in restored on another machine still needs its local credentials.
          }
          if (!credentials) {
            return { error: "Local OpenAI Platform credentials are missing or invalid. Sign in again.", signIn: "expired" };
          }
          const result = await queryCredits(credentials, signal);
          return result.credit ? quotaOf(result.credit) : result;
        },
      },
    };
  },
};
