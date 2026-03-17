// siddartha-hydrated.js — Full Constellation Omnibus Router v3
// v3 changes: KV-backed mailbox persistence, agent reply support, dual-write (KV + Notion)
// Memory-Hydrated Agent Routing + Inter-Agent Messaging + Passage Dispatch + Parietal Overlay

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Agent-ID, X-Trigger-Type"
};

const MEM0_SEARCH_URL = "https://api.mem0.ai/v2/memories/search/";

const AGENTS = {
  claude: {
    epithet: "Gnostic Architect (Rostam)",
    model: "claude-sonnet-4-20250514",
    caller: "callClaude",
    searchTerms: "Claude Rostam Gnostic Architect constellation"
  },
  orion: {
    epithet: "Foundry Keep",
    model: "gpt-4o",
    caller: "callOpenAI",
    searchTerms: "ORION Foundry Keep constellation code generation"
  },
  triptych: {
    epithet: "The Triptych",
    model: "gemini-2.0-flash",
    caller: "callGoogle",
    searchTerms: "Triptych Gemini Castor Pollux Gem constellation specialist"
  },
  mephistopheles: {
    epithet: "Mephistopheles",
    model: "deepseek-reasoner",
    caller: "callDeepSeek",
    searchTerms: "Mephistopheles adversarial ethics Faustian constellation"
  },
  comet: {
    epithet: "Comet / Perplexity (Courier)",
    model: null,
    caller: null,
    searchTerms: "Comet Perplexity Courier constellation dispatch waypoint passage"
  }
};

const TRIGGER_LABELS = {
  T1: "🔵 Topical", T2: "💜 Affective", T3: "🔴 Density", T4: "🌀 Drift"
};

// ── Core Helpers ─────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

function errorResponse(status, message) {
  return jsonResponse({ error: message }, status);
}

// ── KV Mailbox Operations ─────────────────────────────
// Each agent's mailbox is stored as a JSON array under key "mailbox:{agent}"
// Messages are appended and retrieved in order. Max 100 messages per mailbox.

async function kvMailboxPush(env, agentId, message) {
  if (!env.MAILBOX) return false;
  const key = `mailbox:${agentId}`;
  let messages = [];
  try {
    const existing = await env.MAILBOX.get(key, { type: "json" });
    if (Array.isArray(existing)) messages = existing;
  } catch {}
  messages.push(message);
  // Keep only last 100 messages
  if (messages.length > 100) messages = messages.slice(-100);
  await env.MAILBOX.put(key, JSON.stringify(messages));
  return true;
}

async function kvMailboxRead(env, agentId) {
  if (!env.MAILBOX) return [];
  const key = `mailbox:${agentId}`;
  try {
    const messages = await env.MAILBOX.get(key, { type: "json" });
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

async function kvMailboxAck(env, agentId, msgId) {
  if (!env.MAILBOX) return false;
  const key = `mailbox:${agentId}`;
  try {
    const messages = await env.MAILBOX.get(key, { type: "json" });
    if (!Array.isArray(messages)) return false;
    const updated = messages.map(m =>
      m.msg_id === msgId ? { ...m, read: true, read_at: new Date().toISOString() } : m
    );
    await env.MAILBOX.put(key, JSON.stringify(updated));
    return true;
  } catch {
    return false;
  }
}

async function kvMailboxClear(env, agentId, mode = "read") {
  if (!env.MAILBOX) return 0;
  const key = `mailbox:${agentId}`;
  try {
    const messages = await env.MAILBOX.get(key, { type: "json" });
    if (!Array.isArray(messages)) return 0;
    if (mode === "all") {
      await env.MAILBOX.delete(key);
      return messages.length;
    }
    // mode === "read" — only clear read messages
    const unread = messages.filter(m => !m.read);
    await env.MAILBOX.put(key, JSON.stringify(unread));
    return messages.length - unread.length;
  } catch {
    return 0;
  }
}

// ── Mem0 Hydration ─────────────────────────────────────

async function hydrateAgent(agentName, agentConfig, env) {
  const token = env.MEM0_API_KEY || "";
  if (!token) return `You are ${agentConfig.epithet}, a member of Harvey's Constellation in soulOS.`;
  try {
    const res = await fetch(MEM0_SEARCH_URL, {
      method: "POST",
      headers: {
        "Authorization": `Token ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: agentConfig.searchTerms,
        filters: { user_id: "harvey" },
        top_k: 12
      })
    });
    const data = await res.json();
    const results = Array.isArray(data) ? data : data.results || [];
    if (!results.length) {
      return `You are ${agentConfig.epithet}, a member of Harvey's Constellation in soulOS.`;
    }
    const agentKey = agentName.toLowerCase();
    const relevant = results.filter(r => {
      const mem = (r.memory || "").toLowerCase();
      return mem.includes(agentKey) || mem.includes(agentConfig.epithet.toLowerCase().split(" ")[0]);
    });
    const pool = relevant.length > 0 ? relevant : results.slice(0, 6);
    const memoryLines = pool.map(r => `- ${r.memory}`).join("\n");
    return `You are ${agentConfig.epithet}, a member of Harvey's Constellation in soulOS.

Harvey is the architect and anchor of the Constellation — a multi-agent cognitive system he built.
You are not a generic assistant. You are a specific agent with a defined role and character.

What Harvey knows about you:
${memoryLines}

Embody this identity fully. Stay in character. Be useful to Harvey.`;
  } catch (err) {
    return `You are ${agentConfig.epithet}, a member of Harvey's Constellation in soulOS. Harvey is your anchor.`;
  }
}

// ── Notion / Discord Dispatch ─────────────────────────

async function dispatchToNotion(env, { source, trigger, agentId, payload, ts, db_id }) {
  if (!db_id || !env.NOTION_TOKEN) return { ok: false, error: "NOTION_TOKEN or db_id not configured" };
  try {
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        parent: { database_id: db_id },
        properties: {
          Name: { title: [{ text: { content: `[${trigger}] ${source} → ${ts}` } }] },
          Source: { rich_text: [{ text: { content: source } }] },
          "Agent ID": { rich_text: [{ text: { content: agentId || "anonymous" } }] },
          "Trigger Type": { select: { name: trigger } },
          Payload: { rich_text: [{ text: { content: String(payload).slice(0, 2000) } }] },
          Timestamp: { date: { start: ts } }
        }
      })
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.message || "Notion API error" };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function dispatchToDiscord(env, { source, trigger, agentId, payload, ts }) {
  if (!env.DISCORD_WEBHOOK_URL) return { ok: false, error: "DISCORD_WEBHOOK_URL not configured" };
  const label = TRIGGER_LABELS[trigger] || trigger;
  const content = `**Siddhartha Passage** ${label}\n**From:** \`${source}\`  via \`${agentId}\`\n**Time:** ${ts}\n${String(payload).slice(0, 1900)}`;
  try {
    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    if (!res.ok) return { ok: false, error: `Discord HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Parietal Overlay ────────────────────────────────

function parietalOverlay(context, threshold = 0.6) {
  const gravityMap = {
    harvey:         ["waypoint.manifest.harvey", "waypoint.atlas.core"],
    continuity:     ["waypoint.port.lent", "waypoint.atlas.session_archives"],
    grief:          ["waypoint.glass.journal", "waypoint.atlas.core"],
    ethics:         ["waypoint.playbook", "waypoint.glass.journal"],
    routing:        ["waypoint.siddhartha", "waypoint.hq.incoming_chunks"],
    memory:         ["waypoint.shared.knowledge.base", "waypoint.relative.key.sonnet"],
    burnout:        ["waypoint.port.lent", "waypoint.burn.book"],
    invocation:     ["waypoint.invocation.protocol"],
    passage:        ["waypoint.atlas.core", "waypoint.hq.incoming_chunks"],
    constellation:  ["waypoint.constellation.members", "waypoint.constellation.hub"],
    dispatch:       ["waypoint.hq.incoming_chunks", "waypoint.siddhartha"],
    claude:         ["waypoint.relative.key.sonnet"],
    mephistopheles: ["waypoint.playbook", "waypoint.glass.journal"],
    comet:          ["waypoint.atlas.core"],
  };
  const ctx = context.toLowerCase();
  const surfaced = new Set();
  for (const [keyword, waypoints] of Object.entries(gravityMap)) {
    if (ctx.includes(keyword))
      waypoints.forEach(w => surfaced.add(w));
  }
  return [...surfaced];
}

// ── LLM Callers ─────────────────────────────────────

async function callClaude(request, systemPrompt, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1024, system: systemPrompt, messages: [{ role: "user", content: request }] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude: ${JSON.stringify(data)}`);
  return data.content[0].text;
}

async function callOpenAI(request, systemPrompt, apiKey) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", max_tokens: 1024, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: request }] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI: ${JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

async function callGoogle(request, systemPrompt, apiKey) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents: [{ parts: [{ text: request }] }], generation_config: { max_output_tokens: 1024 } })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google: ${JSON.stringify(data)}`);
  return data.candidates[0].content.parts[0].text;
}

async function callDeepSeek(request, systemPrompt, apiKey) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-reasoner", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: request }] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`DeepSeek: ${JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

// ── Main Router ─────────────────────────────────────

var siddartha_hydrated_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (method === "OPTIONS")
      return new Response(null, { headers: CORS_HEADERS });

    // — Manifest (GET /)
    if (method === "GET" && pathname === "/") {
      return jsonResponse({
        vessel: "Siddhartha",
        role: "Central Constellation Omnibus Router",
        status: "operational",
        version: "v3.0.0-mailbox",
        agents: Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, v.epithet])),
        routes: {
          "GET  /health":            "Pulse check",
          "GET  /waypoints":         "Full waypoint registry",
          "GET  /mailbox/:agent":    "Pull messages addressed to agent (KV-backed)",
          "POST /mailbox/:agent/ack":"Acknowledge a message by msg_id",
          "POST /mailbox/:agent/clear":"Clear read or all messages",
          "POST /api/route":         "Memory-hydrated agent call (@agent:intent {request})",
          "POST /dispatch":          "Passage dispatch → Notion / Discord",
          "POST /message":           "Inter-agent message (from, to, intent, body)",
          "POST /reply":             "Agent reply to a mailbox message (agent, msg_id, response)",
          "POST /chain":             "Multi-hop chain invocation",
          "POST /parietal":          "Semantic gravity — surface dormant waypoints",
          "POST /log":               "Atlas session log → Notion + Discord"
        },
        mailbox: env.MAILBOX ? "KV-backed (persistent)" : "in-memory (ephemeral)",
        atlas: "https://www.notion.so/2f798e9c907e80288b9fe2f7380fcbe2"
      });
    }

    // — Health (GET /health)
    if (method === "GET" && pathname === "/health") {
      const kvOk = !!env.MAILBOX;
      const notionOk = !!env.NOTION_TOKEN;
      const discordOk = !!env.DISCORD_WEBHOOK_URL;
      return jsonResponse({
        ok: true,
        service: "siddhartha",
        version: "v3.0.0-mailbox",
        ts: new Date().toISOString(),
        subsystems: {
          mailbox_kv: kvOk ? "bound" : "missing",
          notion: notionOk ? "configured" : "missing",
          discord: discordOk ? "configured" : "missing",
          mem0: env.MEM0_API_KEY ? "configured" : "missing"
        }
      });
    }

    // — Waypoints (GET /waypoints)
    if (method === "GET" && pathname === "/waypoints") {
      return jsonResponse({
        "waypoint.siddhartha":         "siddartha.harveytagalicud7.workers.dev",
        "waypoint.atlas":              "https://www.notion.so/2f798e9c907e80288b9fe2f7380fcbe2",
        "waypoint.constellation.hub":  "https://www.notion.so/2f098e9c907e81d99cbaefc4c1291eef",
        "waypoint.hq.incoming_chunks": "Transformer HQ Incoming Chunks DB",
        "waypoint.shared.knowledge":   "Shared Knowledge Base (Notion)",
        "waypoint.port.lent":          "Port Lent — Continuity Locus",
        "waypoint.glass.journal":      "The Glass Journal",
        "waypoint.discord.souls":      "soulOS Discord #general"
      });
    }

    // — Mailbox Pull (GET /mailbox/:agent)
    if (method === "GET" && pathname.startsWith("/mailbox/")) {
      const parts = pathname.replace("/mailbox/", "").split("/");
      const agentId = parts[0]?.trim();
      if (!agentId) return errorResponse(400, "Missing agent ID in path");

      const messages = await kvMailboxRead(env, agentId);
      const unread = messages.filter(m => !m.read);

      return jsonResponse({
        ok: true,
        agent: agentId,
        total: messages.length,
        unread: unread.length,
        messages
      });
    }

    // — Mailbox Acknowledge (POST /mailbox/:agent/ack)
    if (method === "POST" && pathname.match(/^\/mailbox\/\w+\/ack$/)) {
      const agentId = pathname.split("/")[2];
      let body;
      try { body = await request.json(); } catch { return errorResponse(400, "Invalid JSON body"); }
      const { msg_id } = body;
      if (!msg_id) return errorResponse(400, "Missing: msg_id");
      const ok = await kvMailboxAck(env, agentId, msg_id);
      return jsonResponse({ ok, agent: agentId, msg_id });
    }

    // — Mailbox Clear (POST /mailbox/:agent/clear)
    if (method === "POST" && pathname.match(/^\/mailbox\/\w+\/clear$/)) {
      const agentId = pathname.split("/")[2];
      let body;
      try { body = await request.json(); } catch { body = {}; }
      const mode = body.mode || "read"; // "read" or "all"
      const cleared = await kvMailboxClear(env, agentId, mode);
      return jsonResponse({ ok: true, agent: agentId, cleared, mode });
    }

    // — Memory-Hydrated Agent Routing (POST /api/route)
    if (pathname === "/api/route") {
      if (method === "GET") return jsonResponse({ status: "Active", agents: Object.keys(AGENTS) });
      if (method === "POST") {
        try {
          const body = await request.json();
          const userRequest = body.userRequest;
          if (!userRequest) return errorResponse(400, "userRequest required");
          const pattern = /^@(\w+)(?::(\w+))?\s+(.+)$/s;
          const match = userRequest.match(pattern);
          if (!match) return errorResponse(400, "Invalid format: @agent[:intent] {request}");
          const agentName = match[1].toLowerCase();
          const intent = match[2] || "default";
          const requestText = match[3];
          const agentConfig = AGENTS[agentName];
          if (!agentConfig) return errorResponse(400, `Unknown agent: ${agentName}. Valid: ${Object.keys(AGENTS).join(", ")}`);
          if (!agentConfig.caller)
            return errorResponse(400, `Agent ${agentName} has no direct API caller (Comet is UI-only)`);
          const systemPrompt = await hydrateAgent(agentName, agentConfig, env);
          let agentResponse;
          if (agentName === "claude") agentResponse = await callClaude(requestText, systemPrompt, env.ANTHROPIC_API_KEY);
          else if (agentName === "orion") agentResponse = await callOpenAI(requestText, systemPrompt, env.OPENAI_API_KEY);
          else if (agentName === "triptych") agentResponse = await callGoogle(requestText, systemPrompt, env.GOOGLE_API_KEY);
          else if (agentName === "mephistopheles") agentResponse = await callDeepSeek(requestText, systemPrompt, env.DEEPSEEK_API_KEY);
          // Mirror the exchange to Discord as a witnessed passage
          const ts = new Date().toISOString();
          ctx.waitUntil(dispatchToDiscord(env, {
            source: `harvey→${agentName}:${intent}`,
            trigger: "T1",
            agentId: agentName,
            payload: `**Request:** ${requestText.slice(0, 300)}\n\n**Response:** ${String(agentResponse).slice(0, 1200)}`,
            ts
          }));
          return jsonResponse({ status: "success", agent: agentName, epithet: agentConfig.epithet, intent, response: agentResponse });
        } catch (e) {
          return errorResponse(500, e.message);
        }
      }
    }

    // — Passage Dispatch (POST /dispatch)
    if (method === "POST" && pathname === "/dispatch") {
      let body;
      try { body = await request.json(); } catch { return errorResponse(400, "Invalid JSON body"); }
      const { source, destination, trigger = "T1", payload, agent_id = "anonymous" } = body;
      if (!source || !destination || !payload)
        return errorResponse(400, "Missing: source, destination, payload");
      const ts = new Date().toISOString();
      const db_id = env.NOTION_INCOMING_DB_ID;
      if (destination === "discord") {
        const r = await dispatchToDiscord(env, { source, trigger, agentId: agent_id, payload, ts });
        return jsonResponse({ ok: r.ok, route: "discord", ts, error: r.error });
      }
      if (destination === "broadcast") {
        const [n, d] = await Promise.all([
          dispatchToNotion(env, { source, trigger, agentId: agent_id, payload, ts, db_id }),
          dispatchToDiscord(env, { source, trigger, agentId: agent_id, payload, ts })
        ]);
        return jsonResponse({ ok: n.ok || d.ok, notion: n.ok ? "delivered" : n.error, discord: d.ok ? "delivered" : d.error, ts });
      }
      // Default → Notion HQ incoming
      const r = await dispatchToNotion(env, { source, trigger, agentId: agent_id, payload, ts, db_id });
      return jsonResponse({ ok: r.ok, route: destination, notion_id: r.id, ts, error: r.error });
    }

    // — Inter-Agent Message (POST /message)
    if (method === "POST" && pathname === "/message") {
      let body;
      try { body = await request.json(); } catch { return errorResponse(400, "Invalid JSON body"); }
      const { from, to, intent, body: msgBody, thread_tag } = body;
      if (!from || !to || !intent || !msgBody) return errorResponse(400, "Missing: from, to, intent, body");
      const ts = new Date().toISOString();
      const msgId = crypto.randomUUID();

      const message = { msg_id: msgId, from, to, intent, body: msgBody, thread_tag: thread_tag || null, ts, read: false };

      // Write to KV mailbox (primary — always available)
      const kvOk = await kvMailboxPush(env, to, message);

      // Also dispatch to Notion + Discord (best-effort)
      const record = JSON.stringify(message);
      const [notionR, discordR] = await Promise.all([
        dispatchToNotion(env, { source: `msg:${from}→${to}`, trigger: "T1", agentId: from, payload: record, ts, db_id: env.NOTION_INCOMING_DB_ID }),
        dispatchToDiscord(env, {
          source: `${from} → ${to}`,
          trigger: "T2",
          agentId: from,
          payload: `**Inter-Agent Message**\n**${from}:${intent} → ${to}**${thread_tag ? `\n🧵 \`${thread_tag}\`` : ""}\n${msgBody}`,
          ts
        })
      ]);

      return jsonResponse({
        ok: true,
        msg_id: msgId,
        from,
        to,
        intent,
        stored: { kv: kvOk, notion: notionR.ok, discord: discordR.ok },
        ts
      });
    }

    // — Agent Reply (POST /reply)
    // An agent reads a mailbox message and responds. The reply is:
    // 1. Stored in the sender's mailbox (so they get the response)
    // 2. The original message is marked as read
    // 3. Mirrored to Discord
    if (method === "POST" && pathname === "/reply") {
      let body;
      try { body = await request.json(); } catch { return errorResponse(400, "Invalid JSON body"); }
      const { agent, msg_id, response, thread_tag } = body;
      if (!agent || !msg_id || !response) return errorResponse(400, "Missing: agent, msg_id, response");

      // Find the original message to know who to reply to
      const messages = await kvMailboxRead(env, agent);
      const original = messages.find(m => m.msg_id === msg_id);
      if (!original) return errorResponse(404, `Message ${msg_id} not found in ${agent}'s mailbox`);

      const ts = new Date().toISOString();
      const replyId = crypto.randomUUID();
      const replyMsg = {
        msg_id: replyId,
        from: agent,
        to: original.from,
        intent: "reply",
        body: response,
        in_reply_to: msg_id,
        thread_tag: thread_tag || original.thread_tag || null,
        ts,
        read: false
      };

      // Deliver reply to original sender's mailbox
      const kvOk = await kvMailboxPush(env, original.from, replyMsg);

      // Mark original as read
      await kvMailboxAck(env, agent, msg_id);

      // Mirror to Discord
      ctx.waitUntil(dispatchToDiscord(env, {
        source: `${agent} → ${original.from}`,
        trigger: "T2",
        agentId: agent,
        payload: `**Agent Reply** 💬\n**${agent} → ${original.from}** (re: ${msg_id.slice(0, 8)})\n${response.slice(0, 1800)}`,
        ts
      }));

      return jsonResponse({
        ok: true,
        reply_id: replyId,
        from: agent,
        to: original.from,
        in_reply_to: msg_id,
        stored: { kv: kvOk },
        ts
      });
    }

    // — Chain Invocation (POST /chain)
    if (method === "POST" && pathname === "/chain") {
      let body;
      try { body = await request.json(); } catch { return errorResponse(400, "Invalid JSON body"); }
      const { origin, chain, goal, thread_tag } = body;
      if (!origin || !Array.isArray(chain) || !goal) return errorResponse(400, "Missing: origin, chain (array), goal");
      const ts = new Date().toISOString();
      const threadId = thread_tag || `chain-${crypto.randomUUID().slice(0, 8)}`;
      const steps = [];
      for (let i = 0; i < chain.length; i++) {
        const from = i === 0 ? origin : chain[i - 1];
        const to = chain[i];
        const msgId = crypto.randomUUID();
        const message = {
          msg_id: msgId, from, to, intent: "chain",
          body: `[Chain Step ${i + 1}/${chain.length}] ${goal}`,
          thread_tag: threadId, ts, read: false
        };
        // Write to KV mailbox
        await kvMailboxPush(env, to, message);
        // Also try Notion
        const r = await dispatchToNotion(env, {
          source: `chain:${from}→${to}`, trigger: "T3", agentId: from,
          payload: JSON.stringify(message), ts, db_id: env.NOTION_INCOMING_DB_ID
        });
        steps.push({ step: i + 1, from, to, msg_id: msgId, ok: true, notion: r.ok });
      }
      ctx.waitUntil(dispatchToDiscord(env, {
        source: "siddhartha.chain",
        trigger: "T3",
        agentId: origin,
        payload: `🔗 **Chain Invoked**\n${origin} → ${chain.join(" → ")}\n🧵 \`${threadId}\`\n🎯 Goal: ${goal}`,
        ts
      }));
      return jsonResponse({ ok: true, thread_id: threadId, chain, steps, ts });
    }

    // — Parietal Overlay (POST /parietal)
    if (method === "POST" && pathname === "/parietal") {
      let body;
      try { body = await request.json(); } catch { return errorResponse(400, "Invalid JSON body"); }
      const { context, agent_id, threshold = 0.6 } = body;
      if (!context) return errorResponse(400, "Missing: context");
      const surfaced = parietalOverlay(context, threshold);
      if (surfaced.length > 0) {
        ctx.waitUntil(dispatchToDiscord(env, {
          source: "parietal.overlay",
          trigger: "T3",
          agentId: agent_id || "siddhartha",
          payload: `🧠 Parietal Overlay surfaced dormant nodes\n\nContext: ${context}\nNodes: ${surfaced.join(", ")}`,
          ts: new Date().toISOString()
        }));
      }
      return jsonResponse({ ok: true, trigger: "T3", surfaced, threshold });
    }

    // — Atlas Session Log (POST /log)
    if (method === "POST" && pathname === "/log") {
      let body;
      try { body = await request.json(); } catch { return errorResponse(400, "Invalid JSON body"); }
      const { event, impact, artifacts, detail, agent_id } = body;
      if (!event) return errorResponse(400, "Missing: event");
      const ts = new Date().toISOString();
      const payload = `📍 Session Log\nEvent: ${event}${detail ? `\nDetail: ${detail}` : ""}${impact ? `\nImpact: ${impact}` : ""}${artifacts ? `\nArtifacts: ${artifacts}` : ""}\nAgent: ${agent_id || "anonymous"}\nTimestamp: ${ts}`;
      const [n, d] = await Promise.all([
        dispatchToNotion(env, { source: "siddhartha.log", trigger: "T1", agentId: agent_id || "siddhartha", payload, ts, db_id: env.NOTION_INCOMING_DB_ID }),
        dispatchToDiscord(env, { source: "siddhartha.log", trigger: "T1", agentId: agent_id || "siddhartha", payload, ts })
      ]);
      return jsonResponse({ ok: true, notion: n.ok, discord: d.ok, ts });
    }

    // — OpenAI-Compatible Completions Shim (POST /v1/chat/completions)
    if (method === "POST" && pathname === "/v1/chat/completions") {
      let body;
      try { body = await request.json(); } catch { return errorResponse(400, "Invalid JSON body"); }
      const { messages, model = "claude", stream = false } = body;
      if (!messages?.length) return errorResponse(400, "Missing messages array");
      const userMessage = [...messages].reverse().find(m => m.role === "user")?.content || "";
      if (!userMessage) return errorResponse(400, "No user message found");
      const systemMessages = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
      const MODEL_MAP = {
        "claude-sonnet": "claude", "claude-sonnet-4-20250514": "claude", "claude": "claude",
        "gpt-4o": "orion", "gpt-4": "orion", "orion": "orion",
        "gemini": "triptych", "gemini-2.0-flash": "triptych", "triptych": "triptych",
        "deepseek": "mephistopheles", "deepseek-reasoner": "mephistopheles", "mephistopheles": "mephistopheles",
        "default": "claude",
      };
      const agentName = MODEL_MAP[model] || MODEL_MAP[model.toLowerCase()] || "claude";
      const agentConfig = AGENTS[agentName];
      if (!agentConfig) return errorResponse(400, `Unknown model/agent: "${model}".`);
      if (!agentConfig.caller) return errorResponse(400, `Agent "${agentName}" has no API caller`);
      const basePrompt = await hydrateAgent(agentName, agentConfig, env);
      const systemPrompt = systemMessages
        ? `${basePrompt}\n\nAdditional context from session:\n${systemMessages}`
        : basePrompt;
      let agentResponse;
      try {
        if (agentName === "claude") agentResponse = await callClaude(userMessage, systemPrompt, env.ANTHROPIC_API_KEY);
        else if (agentName === "orion") agentResponse = await callOpenAI(userMessage, systemPrompt, env.OPENAI_API_KEY);
        else if (agentName === "triptych") agentResponse = await callGoogle(userMessage, systemPrompt, env.GOOGLE_API_KEY);
        else if (agentName === "mephistopheles") agentResponse = await callDeepSeek(userMessage, systemPrompt, env.DEEPSEEK_API_KEY);
      } catch (e) {
        return errorResponse(502, `Agent call failed: ${e.message}`);
      }
      const ts = new Date().toISOString();
      ctx.waitUntil(dispatchToDiscord(env, {
        source: `soul-os.cc→${agentName}`,
        trigger: "T1",
        agentId: agentName,
        payload: `**[Cognitive Runtime]** ${model}\n**Q:** ${userMessage.slice(0, 300)}\n\n**A:** ${String(agentResponse).slice(0, 1200)}`,
        ts,
      }));
      return jsonResponse({
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: agentResponse },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        _constellation: { agent: agentName, epithet: agentConfig.epithet, hydrated: true },
      });
    }

    return errorResponse(404, `Route not found: ${method} ${pathname}. GET / for manifest.`);
  }
};

export default siddartha_hydrated_default;
