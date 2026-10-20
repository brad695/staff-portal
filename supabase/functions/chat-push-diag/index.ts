// chat-push-diag — RETIRED 2026-10-19. A one-evening probe for Greys Chat phone notifications (Maverick's
// Android reported its permission / service worker / subscription and each push it received). The phone
// works; chat.html and chat-sw.js no longer call this. Kept as a 410 stub. The chat_push_diag table it
// wrote to (a handful of rows) can be dropped.
Deno.serve(() => new Response(JSON.stringify({ error: "gone" }), {
  status: 410,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
}));
