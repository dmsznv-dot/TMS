// Writes samples/orders-demo.xlsx. Run with: npm run samples
import { mkdirSync, writeFileSync } from "node:fs";
import { buildDemoOrdersXlsx } from "../src/server/seed/demo";

async function main() {
  mkdirSync("samples", { recursive: true });
  writeFileSync("samples/orders-demo.xlsx", await buildDemoOrdersXlsx());
  console.log("samples/orders-demo.xlsx written");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
