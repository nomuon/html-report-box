#!/usr/bin/env bun
/**
 * CDK app entry (cdk.json: "app": "bun bin/hrb.ts").
 *
 * Stack layout:
 *   HrbEdgeStack     us-east-1   WAF WebACLs (CLOUDFRONT scope)
 *   HrbStatefulStack <region>    DynamoDB / S3 / Cognito
 *   HrbAppStack      <region>    Lambdas + HTTP API + schedules
 *   HrbCdnStack      <region>    CloudFront x2 + OAC + headers policy
 */
import { App } from "aws-cdk-lib";
import { loadConfig } from "../src/config.ts";
import { HrbAppStack } from "../src/stacks/app-stack.ts";
import { HrbCdnStack } from "../src/stacks/cdn-stack.ts";
import { HrbEdgeStack } from "../src/stacks/edge-stack.ts";
import { HrbStatefulStack } from "../src/stacks/stateful-stack.ts";

const app = new App();
const config = loadConfig(app);
const env = { account: config.account, region: config.region };

const edge = new HrbEdgeStack(app, "HrbEdgeStack", {
  env: { account: config.account, region: "us-east-1" },
  crossRegionReferences: true,
  config,
});

const stateful = new HrbStatefulStack(app, "HrbStatefulStack", { env, config });

const appStack = new HrbAppStack(app, "HrbAppStack", {
  env,
  config,
  reportsTable: stateful.reportsTable,
  searchTable: stateful.searchTable,
  contentBucket: stateful.contentBucket,
  stagingBucket: stateful.stagingBucket,
  userPool: stateful.userPool,
  spaClient: stateful.spaClient,
});

new HrbCdnStack(app, "HrbCdnStack", {
  env,
  crossRegionReferences: true,
  config,
  appBucketName: stateful.appBucket.bucketName,
  contentBucketName: stateful.contentBucket.bucketName,
  httpApiDomain: appStack.httpApiDomain,
  appWebAclArn: edge.appWebAclArn,
  contentWebAclArn: edge.contentWebAclArn,
});

app.synth();
