import { describe, expect, it } from "vitest";

import { mayAdministerProduct } from "./product-permissions";
import type { AuthenticatedUser } from "./api";
import type { Product } from "./types";

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: "account-1", username: "member@example.com", displayName: "member", role: "member", ...overrides };
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "product-1",
    keyPrefix: "PRD",
    name: "Product",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    hasIcon: false,
    ...overrides,
  };
}

describe("mayAdministerProduct", () => {
  it("lets an administrator administer anything", () => {
    expect(mayAdministerProduct(user({ role: "admin" }), product())).toBe(true);
    expect(mayAdministerProduct(user({ role: "admin" }), product({ createdByAccountId: "somebody-else" }))).toBe(true);
  });

  it("lets a member administer what they created", () => {
    expect(mayAdministerProduct(user(), product({ createdByAccountId: "account-1" }))).toBe(true);
  });

  it("does not let a member administer a product shared with them", () => {
    expect(mayAdministerProduct(user(), product({ createdByAccountId: "account-2" }))).toBe(false);
  });

  it("treats a product with no recorded creator as not a member's", () => {
    // Those predate accounts and the seed backfill hands them to the deployment's
    // administrator. Answering true would draw a control the server refuses.
    expect(mayAdministerProduct(user(), product())).toBe(false);
  });

  it("treats a deleted creator's product as not a member's either", () => {
    // Deleting an account leaves created_by_account_id pointing at an id nobody
    // holds, rather than clearing it. It matches no live account, here and on the
    // server.
    expect(mayAdministerProduct(user(), product({ createdByAccountId: "deleted-account" }))).toBe(false);
  });
});
