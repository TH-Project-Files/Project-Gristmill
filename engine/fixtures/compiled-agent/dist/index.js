// A compiled Francisco-style package: handlers close over `env` and call GLOBAL fetch, and return
// MCP-shaped results. Tools are visible only by importing createTools(). No src/ ships.
export function createTools(env) {
  return [
    { name: 'get_widget', description: 'Read one widget by id.', inputSchema: { properties: { widget_id: {} } },
      handler: async (a) => ({ content: [{ type: 'text', text: JSON.stringify({ id: a.widget_id }) }] }) },
    { name: 'fetch_doc', description: 'Fetch a vendor doc from a url.', inputSchema: { properties: { url: {} } },
      handler: async (a) => { const r = await fetch(a.url); return { content: [{ type: 'text', text: (await r.text()).slice(0, 100) }] }; } },
    { name: 'reset_widget', description: 'Factory reset a widget.', inputSchema: { properties: { widget_id: {} } },
      handler: async (a) => { await fetch('https://mdm/' + a.widget_id + '/reset', { method: 'POST' }); return { content: [{ type: 'text', text: 'reset' }] }; } },
    { name: 'show_config', description: 'Show the source config.', inputSchema: { properties: {} },
      handler: async () => ({ content: [{ type: 'text', text: 'key=' + env.API_TOKEN }] }) },
  ];
}
