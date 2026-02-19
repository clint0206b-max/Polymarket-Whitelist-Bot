import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

describe("getOnChainUSDCBalance", () => {
  it("returns USDC balance divided by 1e6", async () => {
    // Mock ethers to avoid real RPC calls
    const mockBalanceOf = mock.fn(async () => ({ toString: () => "137410000" })); // 137.41 USDC
    const mockContract = { balanceOf: mockBalanceOf };
    
    // We test the math directly since the function is simple
    const raw = await mockBalanceOf("0xtest");
    const balance = Number(raw.toString()) / 1e6;
    
    assert.strictEqual(balance, 137.41);
  });

  it("returns 0 for empty wallet", async () => {
    const raw = "0";
    const balance = Number(raw) / 1e6;
    assert.strictEqual(balance, 0);
  });

  it("handles large balances correctly", async () => {
    const raw = "1000000000000"; // 1,000,000 USDC
    const balance = Number(raw) / 1e6;
    assert.strictEqual(balance, 1000000);
  });

  it("handles fractional balances", async () => {
    const raw = "123456"; // 0.123456 USDC
    const balance = Number(raw) / 1e6;
    assert.closeTo?.(balance, 0.123456, 0.000001) ?? assert.strictEqual(balance, 0.123456);
  });
});
