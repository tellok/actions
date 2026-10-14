const fs = require("node:fs");
const path = require("node:path");
const yaml = require("yaml");
let count = 0;
for (const entry of fs.readdirSync("github-actions", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join("github-actions", entry.name),
    file = path.join(dir, "action.yml");
  if (!fs.existsSync(file)) continue;
  const doc = yaml.parse(fs.readFileSync(file, "utf8"));
  if (doc.runs?.using !== "composite" || !Array.isArray(doc.runs.steps))
    throw new Error("Invalid Action: " + file);
  for (const step of doc.runs.steps)
    if (step.uses && !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(step.uses))
      throw new Error("Unpinned dependency in " + file);
  if (!fs.existsSync(path.join(dir, "README.md")))
    throw new Error("Missing component README: " + dir);
  if (
    /tower|paper-quote|\/mnt\/cache|tellok\//i.test(
      fs.readFileSync(file, "utf8"),
    )
  )
    throw new Error("Consumer-specific configuration in " + file);
  count++;
}
if (count !== 5) throw new Error("Expected five independent components");
console.log("Validated five components and pinned upstream dependencies");
