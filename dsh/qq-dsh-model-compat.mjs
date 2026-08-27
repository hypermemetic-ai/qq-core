import { QWEN_TOKEN_PLAN_MODELS } from "@earendil-works/pi-ai/providers/qwen-token-plan.models";

const provider = process.env.QQ_DSH_PROVIDER ?? "qwen-token-plan";
const model = process.env.QQ_DSH_MODEL ?? "deepseek-v4-pro-0813";

// The dated route is newer than the installed pi-ai catalog. Seed it
// from the compatible Pro declaration before DSH resolves the profile so system
// instructions use `system`, never the provider-rejected `developer` role.
if (provider === "qwen-token-plan" && model === "deepseek-v4-pro-0813") {
  const base = QWEN_TOKEN_PLAN_MODELS["deepseek-v4-pro"];
  if (!base || base.compat?.supportsDeveloperRole !== false) {
    throw new Error("qq: compatible qwen-token-plan Pro model metadata is unavailable");
  }
  QWEN_TOKEN_PLAN_MODELS[model] = Object.freeze({
    ...base,
    id: model,
    name: "DeepSeek V4 Pro 0813",
    compat: Object.freeze({ ...base.compat, supportsDeveloperRole: false }),
  });
}
