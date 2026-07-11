/**
 * HrbAppStack — api / mcp Lambdas (Node 22, prebundled single-file ESM
 * assets), HTTP API Gateway, x-origin-verify enforcement env, plus the
 * scheduled ops Lambdas (daily malicious-domain feed fetch, weekly rescan).
 */
import {
  CfnOutput,
  Duration,
  Fn,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigwv2,
  aws_apigatewayv2_integrations as apigwv2i,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_s3 as s3,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { HrbInfraConfig } from "../config.ts";
import { resolveBundledCode } from "../lambda-code.ts";
import { QUARANTINE_PREFIX, STAGING_PREFIX } from "./stateful-stack.ts";

/** SSM parameter written by HrbCdnStack, read by the api Lambda at runtime. */
export const CONTENT_DISTRIBUTION_ID_PARAM = "/hrb/content-distribution-id";
/** SSM parameter written by HrbCdnStack (https://<content CF domain>). */
export const CONTENT_BASE_URL_PARAM = "/hrb/content-base-url";
/** Staging-bucket key where the daily feed Lambda stores the blocklist JSON. */
export const DOMAIN_BLOCKLIST_KEY = "feeds/domain-blocklist.json";

export interface HrbAppStackProps extends StackProps {
  config: HrbInfraConfig;
  reportsTable: dynamodb.ITable;
  searchTable: dynamodb.ITable;
  contentBucket: s3.IBucket;
  stagingBucket: s3.IBucket;
  userPool: cognito.IUserPool;
  spaClient: cognito.IUserPoolClient;
  /** Test override; defaults to dist/api bundle (or inline placeholder). */
  apiCode?: lambda.Code;
  /** Test override; defaults to dist/mcp bundle (or inline placeholder). */
  mcpCode?: lambda.Code;
}

export class HrbAppStack extends Stack {
  readonly httpApi: apigwv2.HttpApi;
  /** API Gateway hostname (no scheme/path) for the CloudFront origin. */
  readonly httpApiDomain: string;
  readonly apiFunction: lambda.Function;
  readonly mcpFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: HrbAppStackProps) {
    super(scope, id, props);
    const { config } = props;

    // Environment contract consumed by @hrb/core AWS adapters (S6).
    const serviceEnv: Record<string, string> = {
      APP_MODE: "aws",
      REPORTS_TABLE_NAME: props.reportsTable.tableName,
      SEARCH_TABLE_NAME: props.searchTable.tableName,
      CONTENT_BUCKET: props.contentBucket.bucketName,
      STAGING_BUCKET: props.stagingBucket.bucketName,
      STAGING_PREFIX,
      QUARANTINE_PREFIX,
      USER_POOL_ID: props.userPool.userPoolId,
      USER_POOL_CLIENT_ID: props.spaClient.userPoolClientId,
      ORIGIN_VERIFY_SECRET: config.originVerifySecret,
      CONTENT_BASE_URL: config.contentBaseUrl,
      CONTENT_DISTRIBUTION_ID_PARAM,
      CONTENT_BASE_URL_PARAM,
      DOMAIN_BLOCKLIST_BUCKET: props.stagingBucket.bucketName,
      DOMAIN_BLOCKLIST_KEY,
    };

    const fnDefaults = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      memorySize: 1024,
      timeout: Duration.seconds(29), // HTTP API integration cap
      environment: serviceEnv,
    };

    this.apiFunction = new lambda.Function(this, "ApiFunction", {
      ...fnDefaults,
      functionName: "hrb-api",
      description: "HTML Report Box HTTP API (Hono)",
      code: props.apiCode ?? resolveBundledCode("api"),
    });

    this.mcpFunction = new lambda.Function(this, "McpFunction", {
      ...fnDefaults,
      functionName: "hrb-mcp",
      description: "HTML Report Box remote MCP server (Streamable HTTP, stateless)",
      code: props.mcpCode ?? resolveBundledCode("mcp"),
    });

    // Grants — api: full service; mcp: read-only (search/get/list tools).
    props.reportsTable.grantReadWriteData(this.apiFunction);
    props.searchTable.grantReadWriteData(this.apiFunction);
    props.contentBucket.grantReadWrite(this.apiFunction);
    props.stagingBucket.grantReadWrite(this.apiFunction);
    props.reportsTable.grantReadData(this.mcpFunction);
    props.searchTable.grantReadData(this.mcpFunction);
    props.contentBucket.grantRead(this.mcpFunction);
    props.stagingBucket.grantRead(this.mcpFunction); // domain blocklist JSON

    // Cognito user administration (admin list users / toggle admin group /
    // delete account).
    this.apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:ListUsers",
          "cognito-idp:AdminListGroupsForUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminDeleteUser",
        ],
        resources: [props.userPool.userPoolArn],
      }),
    );

    // CDN invalidation + runtime discovery of the content distribution via
    // SSM (the distribution id/domain live in HrbCdnStack; direct references
    // would create a stack cycle).
    this.apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: ["*"],
      }),
    );
    for (const fn of [this.apiFunction, this.mcpFunction]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            Stack.of(this).formatArn({
              service: "ssm",
              resource: "parameter",
              resourceName: "hrb/*",
            }),
          ],
        }),
      );
    }

    // ---- HTTP API ----
    this.httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "hrb-http-api",
      description: "HTML Report Box API + MCP (fronted by CloudFront Distribution A)",
    });
    const apiIntegration = new apigwv2i.HttpLambdaIntegration("ApiIntegration", this.apiFunction);
    const mcpIntegration = new apigwv2i.HttpLambdaIntegration("McpIntegration", this.mcpFunction);
    this.httpApi.addRoutes({
      path: "/api/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: apiIntegration,
    });
    this.httpApi.addRoutes({
      path: "/mcp",
      methods: [apigwv2.HttpMethod.ANY],
      integration: mcpIntegration,
    });
    this.httpApi.addRoutes({
      path: "/mcp/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: mcpIntegration,
    });
    // NOTE: direct access to this endpoint bypasses the WAF; the api/mcp
    // Lambdas must reject requests whose x-origin-verify header does not
    // match ORIGIN_VERIFY_SECRET (enforced in @hrb/api middleware).
    this.httpApiDomain = Fn.select(2, Fn.split("/", this.httpApi.apiEndpoint));

    // ---- Scheduled ops Lambdas ----
    // TODO(S7 follow-up): replace both inline stubs with real bundled
    // handlers — (1) URLhaus + OpenPhish fetch -> s3://<staging>/feeds/
    // domain-blocklist.json for the DomainReputation port, (2) full rescan
    // batch that re-runs @hrb/scanner over published reports and auto-
    // unpublishes on block verdicts. Wiring (rules/permissions) is done here;
    // only the handler bodies are stubs.
    const domainFeedFunction = new lambda.Function(this, "DomainFeedFunction", {
      functionName: "hrb-domain-feed",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        DOMAIN_BLOCKLIST_BUCKET: props.stagingBucket.bucketName,
        DOMAIN_BLOCKLIST_KEY,
      },
      code: lambda.Code.fromInline(
        // TODO: bundle the real feed-fetch handler once implemented.
        `exports.handler = async () => { console.log("stub: fetch URLhaus/OpenPhish -> S3 blocklist (TODO)"); return { ok: true }; };`,
      ),
      description: "Daily malicious-domain feed fetch (stub handler)",
    });
    props.stagingBucket.grantWrite(domainFeedFunction);
    new events.Rule(this, "DailyDomainFeedRule", {
      ruleName: "hrb-daily-domain-feed",
      schedule: events.Schedule.cron({ minute: "0", hour: "3" }), // 03:00 UTC daily
      targets: [new targets.LambdaFunction(domainFeedFunction)],
    });

    const rescanFunction = new lambda.Function(this, "RescanFunction", {
      functionName: "hrb-rescan",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      timeout: Duration.minutes(15),
      memorySize: 1024,
      environment: serviceEnv,
      code: lambda.Code.fromInline(
        // TODO: bundle the real weekly-rescan handler once implemented.
        `exports.handler = async () => { console.log("stub: weekly full rescan of published reports (TODO)"); return { ok: true }; };`,
      ),
      description: "Weekly full rescan of published reports (stub handler)",
    });
    props.reportsTable.grantReadWriteData(rescanFunction);
    props.contentBucket.grantRead(rescanFunction);
    props.stagingBucket.grantRead(rescanFunction);
    new events.Rule(this, "WeeklyRescanRule", {
      ruleName: "hrb-weekly-rescan",
      schedule: events.Schedule.cron({ minute: "0", hour: "4", weekDay: "SUN" }),
      targets: [new targets.LambdaFunction(rescanFunction)],
    });

    new CfnOutput(this, "HttpApiEndpoint", { value: this.httpApi.apiEndpoint });
  }
}
