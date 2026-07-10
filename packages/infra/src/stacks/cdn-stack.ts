/**
 * HrbCdnStack — two CloudFront distributions:
 *
 *   A (app):     SPA from the app bucket (OAC) + /api/* and /mcp* proxied to
 *                the HTTP API with the x-origin-verify custom header.
 *   B (content): user-uploaded reports only, served from the content bucket
 *                (OAC) under /r/<id>/..., with the static security headers
 *                (CSP / nosniff / Referrer-Policy / X-Robots-Tag) and a
 *                CloudFront Function that 404s dot-prefixed keys
 *                (e.g. .extracted.txt) and rewrites /r/* -> reports/*.
 *
 * WAF WebACL ARNs come from HrbEdgeStack (us-east-1) via crossRegionReferences.
 *
 * TODO(custom domain): when the `domain` context is set, add ACM certs
 * (us-east-1) + aliases app.<domain> / reports.<domain> + Route53 records.
 * Not wired yet because deploy is out of scope for this milestone.
 */
import {
  CfnOutput,
  Stack,
  type StackProps,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_s3 as s3,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { HrbInfraConfig } from "../config.ts";
import { buildContentCsp, CONTENT_X_ROBOTS_TAG } from "../content-csp.ts";
import { CONTENT_BASE_URL_PARAM, CONTENT_DISTRIBUTION_ID_PARAM } from "./app-stack.ts";

export interface HrbCdnStackProps extends StackProps {
  config: HrbInfraConfig;
  /** Bucket names (not IBucket) to avoid OAC bucket-policy stack cycles. */
  appBucketName: string;
  contentBucketName: string;
  /** API Gateway hostname from HrbAppStack. */
  httpApiDomain: string;
  /** WAF WebACL ARNs from HrbEdgeStack (us-east-1). */
  appWebAclArn: string;
  contentWebAclArn: string;
}

/**
 * Viewer-request function for Distribution B:
 * - only /r/* is served (everything else 404s)
 * - any dot-prefixed path segment 404s (hides .extracted.txt etc.)
 * - /r/<id>/... is rewritten to the S3 key layout reports/<id>/...
 * - trailing "/" resolves to index.html
 */
export const CONTENT_VIEWER_REQUEST_CODE = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri !== '/r' && uri.indexOf('/r/') !== 0) {
    return { statusCode: 404, statusDescription: 'Not Found' };
  }
  var segments = uri.split('/');
  for (var i = 0; i < segments.length; i++) {
    if (segments[i].length > 0 && segments[i].charAt(0) === '.') {
      return { statusCode: 404, statusDescription: 'Not Found' };
    }
  }
  uri = '/reports' + uri.slice(2);
  if (uri.endsWith('/')) {
    uri += 'index.html';
  }
  request.uri = uri;
  return request;
}`;

/**
 * Viewer-request function for Distribution A: SPA history-API fallback.
 * Extensionless paths rewrite to /index.html. Only attached to the default
 * behavior, so /api/* and /mcp* are unaffected (and API error statuses are
 * never rewritten — deliberately no errorResponses on the distribution).
 */
export const APP_VIEWER_REQUEST_CODE = `function handler(event) {
  var request = event.request;
  if (request.uri.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`;

export class HrbCdnStack extends Stack {
  readonly appDistribution: cloudfront.Distribution;
  readonly contentDistribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: HrbCdnStackProps) {
    super(scope, id, props);
    const { config } = props;

    // Imported by name: bucket policies granting OAC read (scoped to this
    // account) are managed in HrbStatefulStack to avoid a stack cycle.
    const appBucket = s3.Bucket.fromBucketName(this, "AppBucketRef", props.appBucketName);
    const contentBucket = s3.Bucket.fromBucketName(
      this,
      "ContentBucketRef",
      props.contentBucketName,
    );

    // ---- Distribution B: content ----

    const contentHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, "ContentHeaders", {
      responseHeadersPolicyName: "hrb-content-headers",
      comment: "Static security headers for uploaded report content",
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: buildContentCsp(),
          override: true,
        },
        contentTypeOptions: { override: true }, // X-Content-Type-Options: nosniff
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [{ header: "X-Robots-Tag", value: CONTENT_X_ROBOTS_TAG, override: true }],
      },
    });

    const contentRequestFunction = new cloudfront.Function(this, "ContentRequestFunction", {
      functionName: "hrb-content-request",
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(CONTENT_VIEWER_REQUEST_CODE),
      comment: "404 dot-keys, restrict to /r/*, rewrite to reports/* keys",
    });

    this.contentDistribution = new cloudfront.Distribution(this, "ContentDistribution", {
      comment: "hrb content (uploaded reports, cookieless origin)",
      webAclId: props.contentWebAclArn,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(contentBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: contentHeadersPolicy,
        functionAssociations: [
          {
            function: contentRequestFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
    });

    // ---- Distribution A: app ----

    const appRequestFunction = new cloudfront.Function(this, "AppRequestFunction", {
      functionName: "hrb-app-request",
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(APP_VIEWER_REQUEST_CODE),
      comment: "SPA history-API fallback (default behavior only)",
    });

    const apiOrigin = new origins.HttpOrigin(props.httpApiDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: { "x-origin-verify": config.originVerifySecret },
    });
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    this.appDistribution = new cloudfront.Distribution(this, "AppDistribution", {
      comment: "hrb app (SPA + API + MCP)",
      webAclId: props.appWebAclArn,
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(appBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: appRequestFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        "/api/*": apiBehavior,
        "/mcp": apiBehavior,
        "/mcp/*": apiBehavior,
      },
    });

    // Runtime discovery for the api Lambda (invalidation target + shared-URL
    // base) without a cdn -> app -> cdn reference cycle.
    new ssm.StringParameter(this, "ContentDistributionIdParam", {
      parameterName: CONTENT_DISTRIBUTION_ID_PARAM,
      stringValue: this.contentDistribution.distributionId,
    });
    new ssm.StringParameter(this, "ContentBaseUrlParam", {
      parameterName: CONTENT_BASE_URL_PARAM,
      stringValue: `https://${this.contentDistribution.distributionDomainName}`,
    });

    new CfnOutput(this, "AppDistributionDomain", {
      value: this.appDistribution.distributionDomainName,
    });
    new CfnOutput(this, "ContentDistributionDomain", {
      value: this.contentDistribution.distributionDomainName,
    });
  }
}
