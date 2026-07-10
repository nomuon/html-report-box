/**
 * @hrb/infra — CDK stacks: HrbEdgeStack / HrbStatefulStack / HrbAppStack /
 * HrbCdnStack. App entry: bin/hrb.ts (cdk.json "app": "bun bin/hrb.ts").
 */
export const PACKAGE_NAME = "@hrb/infra";

export { loadConfig, type HrbInfraConfig } from "./config.ts";
export { buildContentCsp, CONTENT_X_ROBOTS_TAG } from "./content-csp.ts";
export { resolveBundledCode, PLACEHOLDER_HANDLER_CODE } from "./lambda-code.ts";
export { HrbEdgeStack, type HrbEdgeStackProps } from "./stacks/edge-stack.ts";
export {
  HrbStatefulStack,
  type HrbStatefulStackProps,
  STAGING_PREFIX,
  QUARANTINE_PREFIX,
} from "./stacks/stateful-stack.ts";
export {
  HrbAppStack,
  type HrbAppStackProps,
  CONTENT_DISTRIBUTION_ID_PARAM,
  CONTENT_BASE_URL_PARAM,
  DOMAIN_BLOCKLIST_KEY,
} from "./stacks/app-stack.ts";
export {
  HrbCdnStack,
  type HrbCdnStackProps,
  CONTENT_VIEWER_REQUEST_CODE,
  APP_VIEWER_REQUEST_CODE,
} from "./stacks/cdn-stack.ts";
