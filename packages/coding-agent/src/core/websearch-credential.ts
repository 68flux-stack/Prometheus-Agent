// Shared identifiers for the bundled websearch skill's optional Exa credential,
// used by the /login UI (auth.json key) and the kernel env injection. The skill
// works anonymously against Exa's MCP server without this key; it only raises
// the free-tier rate limit.
export const WEBSEARCH_SKILL_NAME = "websearch";
export const EXA_CREDENTIAL_ID = "exa";
export const EXA_CREDENTIAL_NAME = "Exa (web search)";
export const EXA_ENV_VAR = "EXA_API_KEY";
