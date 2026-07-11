/**
 * CognitoUserAdmin — UserAdmin over the Cognito user pool.
 * ListUsers + AdminListGroupsForUser (per user, page-sized) for the admin
 * flag; AdminAddUserToGroup / AdminRemoveUserFromGroup to toggle it;
 * AdminGetUser to resolve the sub; AdminDeleteUser to delete the account.
 * Matches the IAM actions granted to the api Lambda in HrbAppStack.
 * Portable (Node 22 / Lambda); no Bun-only APIs.
 */
import {
  AdminAddUserToGroupCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { AdminUser } from "@hrb/shared";
import { DomainError } from "../errors.ts";
import type { Page, PageOptions, UserAdmin } from "../ports.ts";
import { COGNITO_ADMIN_GROUP } from "./auth.ts";
import type { CommandClient } from "./types.ts";

/** ListUsers caps Limit at 60. */
const MAX_LIST_USERS_LIMIT = 60;

interface CognitoAttribute {
  Name?: string;
  Value?: string;
}

interface CognitoUserType {
  Username?: string;
  Attributes?: CognitoAttribute[];
}

function attribute(user: CognitoUserType, name: string): string | undefined {
  return user.Attributes?.find((a) => a.Name === name)?.Value;
}

function isUserNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "UserNotFoundException"
  );
}

export interface CognitoUserAdminOptions {
  client: CommandClient;
  userPoolId: string;
  adminGroup?: string;
}

export class CognitoUserAdmin implements UserAdmin {
  private readonly client: CommandClient;
  private readonly userPoolId: string;
  private readonly adminGroup: string;

  constructor(options: CognitoUserAdminOptions) {
    this.client = options.client;
    this.userPoolId = options.userPoolId;
    this.adminGroup = options.adminGroup ?? COGNITO_ADMIN_GROUP;
  }

  async listUsers(opts?: PageOptions): Promise<Page<AdminUser>> {
    const limit = Math.min(opts?.limit ?? MAX_LIST_USERS_LIMIT, MAX_LIST_USERS_LIMIT);
    const res = await this.client.send(
      new ListUsersCommand({
        UserPoolId: this.userPoolId,
        Limit: limit,
        // Cognito's PaginationToken is already an opaque string cursor.
        ...(opts?.cursor ? { PaginationToken: opts.cursor } : {}),
      }),
    );
    const users = (res?.Users ?? []) as CognitoUserType[];
    const items: AdminUser[] = [];
    for (const user of users) {
      if (!user.Username) continue;
      const name = attribute(user, "name");
      const email = attribute(user, "email");
      items.push({
        username: user.Username,
        ...(name !== undefined ? { name } : {}),
        ...(email !== undefined ? { email } : {}),
        isAdmin: await this.isInAdminGroup(user.Username),
      });
    }
    const nextCursor = res?.PaginationToken as string | undefined;
    return nextCursor ? { items, nextCursor } : { items };
  }

  async setAdmin(username: string, isAdmin: boolean): Promise<void> {
    const input = {
      UserPoolId: this.userPoolId,
      Username: username,
      GroupName: this.adminGroup,
    };
    try {
      await this.client.send(
        isAdmin ? new AdminAddUserToGroupCommand(input) : new AdminRemoveUserFromGroupCommand(input),
      );
    } catch (err) {
      if (isUserNotFound(err)) {
        throw new DomainError("not_found", `user ${username} does not exist`);
      }
      throw err;
    }
  }

  async getUserSub(username: string): Promise<string | null> {
    try {
      const res = await this.client.send(
        new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: username }),
      );
      const attrs = (res?.UserAttributes ?? []) as CognitoAttribute[];
      return attrs.find((a) => a.Name === "sub")?.Value ?? null;
    } catch (err) {
      if (isUserNotFound(err)) return null;
      throw err;
    }
  }

  async deleteUser(username: string): Promise<void> {
    try {
      await this.client.send(
        new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: username }),
      );
    } catch (err) {
      if (isUserNotFound(err)) {
        throw new DomainError("not_found", `user ${username} does not exist`);
      }
      throw err;
    }
  }

  private async isInAdminGroup(username: string): Promise<boolean> {
    const res = await this.client.send(
      new AdminListGroupsForUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      }),
    );
    const groups = (res?.Groups ?? []) as Array<{ GroupName?: string }>;
    return groups.some((g) => g.GroupName === this.adminGroup);
  }
}
