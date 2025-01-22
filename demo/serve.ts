import index from "./src/index.html";

const server = Bun.serve({
  static: {
    "/": index,
  },
  development: true,
  fetch(req) {
    return new Response("404!");
  },
});
console.log(`Running on http://${server.hostname}:${server.port}`);
