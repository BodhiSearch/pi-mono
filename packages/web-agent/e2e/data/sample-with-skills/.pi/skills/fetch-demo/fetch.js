const url = process.argv[2];
if (!url) {
  console.error('usage: node fetch.js <url>');
  throw new Error('missing url');
}
const res = await fetch(url);
const body = await res.text();
console.log(`STATUS ${res.status}`);
console.log(`BODY ${body.slice(0, 200)}`);
