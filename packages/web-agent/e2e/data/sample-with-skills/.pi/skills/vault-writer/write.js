const text = process.argv[2] ?? '';
const target = '/vault/skill-output.txt';
await vault.writeFile(target, text);
const readBack = await vault.readFile(target);
console.log(`WROTE ${target}`);
console.log(`READ ${readBack}`);
