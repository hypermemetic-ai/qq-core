import { createQqService } from "./session.mjs";
import { attachSessionHistory } from "./session-history.mjs";
import { attachSkillToolVisibility } from "./skill-tool.mjs";

export const name = "qq";
export const inject = ["agents", "sessions", "sessionPersistence"];
export const provide = "qq";

/** Provide the presentation-neutral DSH session service and its alias book. */
export function apply(ctx, config) {
  const service = createQqService(ctx, config ?? {});
  ctx.provide("qq", service);
  ctx.provide("qq-aliases", Object.freeze({
    alias: service.alias,
    resolve: service.resolve,
  }));
  const attachVisibility = (holder) => attachSkillToolVisibility(holder ?? ctx);
  if (typeof ctx.inject === "function") ctx.inject(["tools", "skills"], attachVisibility);
  else attachVisibility(ctx);

  // DSH intentionally keeps sessionQuery policy-neutral. Mount QQ's user-only
  // activation layer only while all optional services are present; a service
  // reload disposes every scoped grant before this injection is re-applied.
  const attachHistory = (holder) => attachSessionHistory(holder ?? ctx, { qq: service });
  if (typeof ctx.inject === "function") {
    ctx.inject(["sessionQuery", "tools", "skills"], attachHistory);
  } else {
    attachHistory(ctx);
  }
}
