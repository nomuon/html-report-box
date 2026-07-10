/**
 * HrbEdgeStack — us-east-1 only (CLOUDFRONT-scoped WAF must live there).
 *
 * Two WebACLs (app distribution / content distribution), both:
 *   - default action: Block (closed network posture)
 *   - priority 0: rate-based Block rule (flood protection, applies even to
 *     allowed CIDRs)
 *   - priority 1: Allow for the shared IPSet built from the `allowedCidrs`
 *     context parameter
 *
 * The ACL ARNs are consumed by HrbCdnStack via crossRegionReferences.
 */
import { Stack, type StackProps } from "aws-cdk-lib";
import { aws_wafv2 as wafv2 } from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { HrbInfraConfig } from "../config.ts";

export interface HrbEdgeStackProps extends StackProps {
  config: HrbInfraConfig;
}

export class HrbEdgeStack extends Stack {
  readonly appWebAclArn: string;
  readonly contentWebAclArn: string;

  constructor(scope: Construct, id: string, props: HrbEdgeStackProps) {
    super(scope, id, props);
    const { config } = props;

    const ipSet = new wafv2.CfnIPSet(this, "AllowedIpSet", {
      name: "hrb-allowed-cidrs",
      description: "Internal network CIDRs allowed to reach HTML Report Box",
      scope: "CLOUDFRONT",
      ipAddressVersion: "IPV4",
      addresses: config.allowedCidrs,
    });

    const makeAcl = (constructId: string, metricName: string): wafv2.CfnWebACL =>
      new wafv2.CfnWebACL(this, constructId, {
        name: metricName,
        scope: "CLOUDFRONT",
        defaultAction: { block: {} },
        rules: [
          {
            name: "rate-limit",
            priority: 0,
            action: { block: {} },
            statement: {
              rateBasedStatement: {
                limit: config.wafRateLimit,
                aggregateKeyType: "IP",
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: `${metricName}-rate-limit`,
              sampledRequestsEnabled: true,
            },
          },
          {
            name: "allow-internal-cidrs",
            priority: 1,
            action: { allow: {} },
            statement: {
              ipSetReferenceStatement: { arn: ipSet.attrArn },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: `${metricName}-allow-internal`,
              sampledRequestsEnabled: true,
            },
          },
        ],
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName,
          sampledRequestsEnabled: true,
        },
      });

    this.appWebAclArn = makeAcl("AppWebAcl", "hrb-app-waf").attrArn;
    this.contentWebAclArn = makeAcl("ContentWebAcl", "hrb-content-waf").attrArn;
  }
}
