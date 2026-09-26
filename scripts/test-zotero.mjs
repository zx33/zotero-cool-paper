// Scaffold 0.8.2's SIGINT handler kills Zotero processes by name. Keep test
// shutdown restricted to the child we launched, so open user profiles survive.
import { Config, Test } from "zotero-plugin-scaffold";
import process from "node:process";
import console from "node:console";

process.env.NODE_ENV ??= "test";
const flags = new Set(process.argv.slice(2));
const supported = new Set([
  "--no-watch",
  "--exit-on-finish",
  "--abort-on-fail",
]);
for (const flag of flags) {
  if (!supported.has(flag)) throw new Error(`Unsupported test option: ${flag}`);
}
const context = await Config.loadConfig({
  test: {
    watch: !flags.has("--no-watch") && !flags.has("--exit-on-finish"),
    abortOnFail: flags.has("--abort-on-fail"),
  },
});
const test = new Test(context);
let interrupted = false;
const onExit = test.onZoteroExit;
test.onZoteroExit = () => {
  if (interrupted) process.exit(130);
  onExit();
};
const stop = () => {
  if (interrupted) return;
  interrupted = true;
  test.reporter.stop();
  const child = test.zotero?.zotero;
  if (child && child.exitCode === null) child.kill("SIGTERM");
  else process.exit(130);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  await test.run();
} catch (error) {
  test.zotero?.zotero?.kill("SIGTERM");
  test.reporter.stop();
  console.error(error);
  process.exit(1);
}
