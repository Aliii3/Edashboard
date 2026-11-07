const fs=require('fs'),path=require('path');const S=path.join(__dirname,'src');
const js=['01-core.js','02-domain.js','03-seed.js','04-ui-kit.js','05-views-core.js','06-views-ops.js','07-views-biz.js','08-actions.js','09-boot.js'].map(f=>fs.readFileSync(path.join(S,f),'utf8')).join('\n');
const css=fs.readFileSync(path.join(S,'styles.css'),'utf8');
const html=`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Commerce OS</title><style>
${css}</style></head><body><div class="app"><header class="workspace-header"><a class="wordmark" href="#/overview"><span class="logo-mark" aria-hidden="true">c<span>o</span></span><span>commerce<span class="logo-os">OS</span><small id="workspaceName">Nile Studio</small></span></a><nav id="nav" aria-label="Main navigation"></nav><a href="#/settings" class="avatar" title="Demo operator, prototype only: no sign-in" style="text-decoration:none">DO</a></header><main id="main"><p class="empty">Loading workspace…</p></main></div>
<form class="command-dock" id="dock" role="search"><div class="search-results" id="searchResults" hidden></div><input name="query" aria-label="Search orders, customers, drivers, SKUs and delivery IDs" placeholder="Find an order, customer, driver or SKU…" autocomplete="off"><span class="dock-key">⌘K</span><button type="submit" aria-label="Open first result">↗</button></form>
<dialog id="dialog" aria-labelledby="modalTitle"></dialog><div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
<noscript><p style="padding:20px">Commerce OS needs JavaScript to run.</p></noscript>
<script>
'use strict';
${js}
</script></body></html>
`;
fs.writeFileSync(process.argv[2],html);console.log('built',process.argv[2],(html.length/1024|0)+'KB');
