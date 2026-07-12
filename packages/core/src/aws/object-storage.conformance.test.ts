/**
 * S3ObjectStorage に object-storage の共通契約スイートを流す。ステートフルな
 * FakeS3Client（test-support.ts）が実際にバイト列を保持するため、ネットワーク
 * なしで round-trip を検証できる。presign は注入したフェイクで生成し、
 * createPresignedUpload が返す形（method/url/key/maxSizeBytes）を検証する。
 *
 * Dynamo 系（repository/search-index）の AWS 実装にはスイートを流さない
 * （既存のコール契約テストを維持。インメモリ Dynamo エミュレーションは対象外）。
 */
import { runObjectStorageConformance } from "../conformance/object-storage.suite.ts";
import { S3ObjectStorage } from "./object-storage.ts";
import { FakeS3Client } from "./test-support.ts";

const STAGING = "hrb-staging";
const CONTENT = "hrb-content";

runObjectStorageConformance("S3ObjectStorage", () => {
  const client = new FakeS3Client();
  const storage = new S3ObjectStorage({
    client,
    stagingBucket: STAGING,
    contentBucket: CONTENT,
    // 実 presign（要 region/credentials）を避け、決定的なフェイクを注入。
    presignPost: async (params) => ({
      url: `https://${params.Bucket}.s3.example/`,
      fields: { key: params.Key, policy: "p" },
    }),
  });
  return {
    storage,
    putStaging: (key, data) => client.put(STAGING, key, data),
  };
});
