import type { PlatformOperatorSession } from "@lemmacomputer/workspace-store";

const safeJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
const safeAttribute = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

export function renderPlatformOperatorUi(session: PlatformOperatorSession, options: { baseHref?: string } = {}) {
  const bootstrap = safeJson({ roles: session.roles, operatorId: session.principal.operatorId });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${options.baseHref ? `<base href="${safeAttribute(options.baseHref)}">` : ""}
  <title>Platform operations · LemmaComputer</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#14213d;background:#f4f7fb;line-height:1.45}
    *{box-sizing:border-box}body{margin:0}.shell{min-height:100vh;display:grid;grid-template-columns:248px 1fr}.rail{background:#10254a;color:#dbe8ff;padding:28px 22px;display:flex;flex-direction:column;gap:28px}.brand{font-size:19px;font-weight:750;color:#fff}.realm{font-size:12px;padding:7px 9px;border:1px solid #4c6b9d;border-radius:8px;background:#19345f}.rail nav{display:grid;gap:6px}.rail a{color:#c9d8f0;text-decoration:none;padding:9px 10px;border-radius:8px}.rail a:first-child{background:#244677;color:#fff}.identity{margin-top:auto;font-size:12px;color:#aec2e2}.main{padding:34px 42px 60px;max-width:1480px;width:100%}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}.eyebrow{font-size:13px;color:#5f6f86;font-weight:650}.top h1{font-size:34px;line-height:1.15;margin:6px 0 5px}.sub{color:#607086;margin:0}.button{border:1px solid #c7d2e2;background:#fff;color:#18365e;border-radius:8px;padding:10px 14px;font:inherit;font-weight:700;cursor:pointer}.button.primary{background:#224b8f;color:#fff;border-color:#224b8f}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:28px 0}.card{background:#fff;border:1px solid #dfe6ef;border-radius:12px;box-shadow:0 4px 14px rgba(24,50,84,.05);padding:20px}.metric-label{font-size:13px;color:#68778b}.metric-value{font-size:27px;font-weight:760;margin-top:8px}.status{font-size:13px;font-weight:750;text-transform:capitalize}.status.available{color:#147548}.status.degraded{color:#a54e16}.grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(320px,.8fr);gap:18px;align-items:start}.stack{display:grid;gap:18px}h2{font-size:18px;margin:0 0 15px}table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:#69788d;font-size:12px;text-transform:uppercase;letter-spacing:.04em}th,td{padding:11px 8px;border-bottom:1px solid #edf1f6}tbody tr:last-child td{border-bottom:0}.pill{display:inline-block;padding:3px 8px;border-radius:999px;background:#edf3fb;color:#31547d;font-size:12px;font-weight:700;text-transform:capitalize}.empty{color:#758398;font-size:14px}form{display:grid;gap:12px}label{font-size:13px;font-weight:700;display:grid;gap:6px}input,select,textarea{width:100%;font:inherit;color:#182942;border:1px solid #c8d3e2;border-radius:8px;background:#fff;padding:10px 11px}textarea{min-height:92px;resize:vertical}.form-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.notice{font-size:13px;padding:10px;border-radius:8px;background:#eff6ff;color:#254f82;min-height:40px}.notice:empty{display:none}.audit-list{display:grid;gap:9px}.audit-item{border-left:3px solid #b9c9df;padding-left:10px;font-size:13px}.audit-item small{display:block;color:#718097}@media(max-width:900px){.shell{grid-template-columns:1fr}.rail{display:none}.main{padding:24px 18px}.metrics,.grid{grid-template-columns:1fr}.top{align-items:center}.form-row{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="shell">
    <aside class="rail">
      <div class="brand">LemmaComputer</div>
      <div class="realm">Workforce operator realm</div>
      <nav aria-label="Platform sections"><a href="#overview">Overview</a><a href="#tenants">Organizations</a><a href="#incidents">Incidents</a><a href="#support">Support access</a><a href="#audit">Audit</a></nav>
      <div class="identity"><div>Separate from customer accounts</div><div id="operator-roles"></div></div>
    </aside>
    <main class="main" id="overview">
      <header class="top"><div><div class="eyebrow">Hosted control plane</div><h1>Platform operations</h1><p class="sub">Operate organizations without becoming a customer member.</p></div><div><a class="button" href="/api/v1/platform/auth/step-up?return=%2Fapi%2Fv1%2Fplatform%2Fui">Verify for sensitive actions</a> <button class="button" id="sign-out" type="button">Sign out</button></div></header>
      <section class="metrics" aria-label="Platform status">
        <article class="card"><div class="metric-label">Service health</div><div class="metric-value"><span class="status" id="health-status">Loading…</span></div><div class="metric-label" id="health-detail"></div></article>
        <article class="card"><div class="metric-label">Organizations</div><div class="metric-value" id="tenant-count">—</div><div class="metric-label">Visible to your operator role</div></article>
        <article class="card"><div class="metric-label">Active incidents</div><div class="metric-value" id="incident-count">—</div><div class="metric-label">Open or monitoring</div></article>
      </section>
      <div class="grid">
        <div class="stack">
          <section class="card" id="tenants"><h2>Organizations</h2><table><thead><tr><th>Name</th><th>Lifecycle</th><th>Last operator change</th></tr></thead><tbody id="tenant-rows"><tr><td colspan="3" class="empty">Loading organizations…</td></tr></tbody></table></section>
          <section class="card" id="incidents"><h2>Incidents</h2><table><thead><tr><th>Incident</th><th>Severity</th><th>Status</th><th>Updated</th></tr></thead><tbody id="incident-rows"><tr><td colspan="4" class="empty">Loading incidents…</td></tr></tbody></table></section>
          <section class="card" id="elevations"><h2>Support elevations</h2><table><thead><tr><th>Elevation ID</th><th>Organization</th><th>Scope</th><th>Status</th><th>Expires</th><th>Actions</th></tr></thead><tbody id="elevation-rows"><tr><td colspan="6" class="empty">Loading elevations…</td></tr></tbody></table><div class="notice" id="elevation-action-result" role="status"></div></section>
          <section class="card" id="audit"><h2>Recent operator audit</h2><div class="audit-list" id="audit-list"><div class="empty">Loading audit events…</div></div></section>
        </div>
        <aside class="stack">
          <section class="card" id="support-panel"><h2>Request tenant access</h2><form id="elevation-form">
            <label>Target organization<select id="elevation-target" required><option value="">Select an organization</option></select></label>
            <label>Reason<textarea id="elevation-reason" minlength="12" maxlength="1000" required placeholder="Reference the customer request or incident"></textarea></label>
            <label>Scope<select id="elevation-scope"><option value="support.diagnostics.read">Diagnostics read</option><option value="support.configuration.read">Configuration read</option><option value="support.customer-content.read">Customer content read — approval required</option><option value="support.identity-recovery.manage">Identity recovery — approval required</option></select></label>
            <div class="form-row"><label>Duration<select id="elevation-duration"><option value="15">15 minutes</option><option value="30">30 minutes</option></select></label><label>Mode<select id="elevation-kind"><option value="support">Support</option><option value="break-glass">Break glass</option></select></label></div>
            <button class="button primary" type="submit">Request tenant access</button><div class="notice" id="elevation-result" role="status"></div>
          </form></section>
          <section class="card" id="lifecycle-panel"><h2>Update organization lifecycle</h2><form id="lifecycle-form">
            <label>Organization<select id="lifecycle-target" required><option value="">Select an organization</option></select></label>
            <label>Lifecycle state<select id="lifecycle-state"><option value="active">Active</option><option value="suspended">Suspended</option><option value="offboarding">Offboarding</option><option value="closed">Closed</option></select></label>
            <label>Change reason<textarea id="lifecycle-reason" minlength="12" maxlength="1000" required></textarea></label>
            <button class="button primary" type="submit">Save lifecycle</button><div class="notice" id="lifecycle-result" role="status"></div>
          </form></section>
          <section class="card" id="incident-panel"><h2>Create incident</h2><form id="incident-form">
            <label>Incident title<input id="incident-title" minlength="4" maxlength="200" required></label>
            <label>Summary<textarea id="incident-summary" minlength="12" maxlength="4000" required></textarea></label>
            <label>Severity<select id="incident-severity"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
            <button class="button primary" type="submit">Create incident</button><div class="notice" id="incident-result" role="status"></div>
          </form></section>
          <section class="card" id="configuration-panel"><h2>Update platform configuration</h2><form id="configuration-form">
            <label>Configuration key<input id="configuration-key" pattern="[a-z][a-z0-9]*(\\.[a-z][a-zA-Z0-9]*)+" required placeholder="support.defaultApprovalRequired"></label>
            <label>JSON value<textarea id="configuration-value" required placeholder='{"enabled":true}'></textarea></label>
            <label>Change reason<textarea id="configuration-reason" minlength="12" maxlength="1000" required></textarea></label>
            <button class="button primary" type="submit">Save configuration</button><div class="notice" id="configuration-result" role="status"></div>
          </form></section>
          <section class="card"><h2>Authority boundary</h2><p class="empty">Tenant access requires a target, reason, bounded scope, recent workforce step-up, expiry, and correlated audit record. Customer sessions grant no operator authority.</p></section>
        </aside>
      </div>
    </main>
  </div>
  <script id="platform-bootstrap" type="application/json">${bootstrap}</script>
  <script type="module">
    const bootstrap=JSON.parse(document.querySelector('#platform-bootstrap').textContent);
    document.querySelector('#operator-roles').textContent=bootstrap.roles.join(' · ');
    const isAdministrator=bootstrap.roles.includes('platform-administrator');const isAuditor=bootstrap.roles.includes('security-auditor');const canSupport=isAdministrator||bootstrap.roles.includes('support-operator');const canManageIncidents=canSupport;const canAudit=isAdministrator||isAuditor;const canReadElevations=canSupport||isAuditor;const canApproveElevations=isAdministrator||isAuditor;
    document.querySelector('#support-panel').hidden=!canSupport;document.querySelector('#lifecycle-panel').hidden=!isAdministrator;document.querySelector('#incident-panel').hidden=!canManageIncidents;document.querySelector('#configuration-panel').hidden=!isAdministrator;document.querySelector('#audit').hidden=!canAudit;document.querySelector('#elevations').hidden=!canReadElevations;
    const api=async(path,options={})=>{const response=await fetch('/api/v1/platform/'+path,{cache:'no-store',...options,headers:{...(options.body?{'content-type':'application/json'}:{}),...(options.headers||{})}});if(!response.ok)throw new Error(String(response.status));return response.status===204?null:response.json()};
    const textCell=(row,value)=>{const cell=document.createElement('td');cell.textContent=value??'—';row.append(cell);return cell};
    const loadTenants=async()=>{const {tenants}=await api('tenants');document.querySelector('#tenant-count').textContent=String(tenants.length);const body=document.querySelector('#tenant-rows');body.textContent='';const targets=[document.querySelector('#elevation-target'),document.querySelector('#lifecycle-target')];for(const tenant of tenants){const row=document.createElement('tr');textCell(row,tenant.displayName);const state=textCell(row,'');const pill=document.createElement('span');pill.className='pill';pill.textContent=tenant.lifecycleState;state.append(pill);textCell(row,tenant.updatedAt?new Date(tenant.updatedAt).toLocaleString():'No operator change');body.append(row);for(const target of targets){const option=document.createElement('option');option.value=tenant.id;option.textContent=tenant.displayName;target.append(option)}}if(!tenants.length)body.innerHTML='<tr><td colspan="3" class="empty">No organizations available.</td></tr>'};
    const loadHealth=async()=>{const {health}=await api('service-health');const status=document.querySelector('#health-status');status.textContent=health.status==='degraded'?'Degraded':'Available';status.className='status '+health.status;document.querySelector('#health-detail').textContent=health.activeIncidents+' active incident'+(health.activeIncidents===1?'':'s')};
    const loadIncidents=async()=>{const {incidents}=await api('incidents');document.querySelector('#incident-count').textContent=String(incidents.filter((item)=>item.status!=='resolved').length);const body=document.querySelector('#incident-rows');body.textContent='';for(const incident of incidents){const row=document.createElement('tr');textCell(row,incident.title);const severity=textCell(row,'');const severityPill=document.createElement('span');severityPill.className='pill';severityPill.textContent=incident.severity;severity.append(severityPill);textCell(row,incident.status);textCell(row,incident.updatedAt?new Date(incident.updatedAt).toLocaleString():'—');body.append(row)}if(!incidents.length)body.innerHTML='<tr><td colspan="4" class="empty">No incidents.</td></tr>'};
    const elevationAction=async(id,action)=>{const result=document.querySelector('#elevation-action-result');result.textContent=(action==='approve'?'Approving ':'Revoking ')+id+'…';try{await api('support/elevations/'+encodeURIComponent(id)+'/'+action,{method:'POST'});result.textContent='Elevation '+id+' '+(action==='approve'?'approved.':'revoked.');await loadElevations()}catch{result.textContent='Elevation action was not completed. Verify your workforce identity and role, then try again.'}};
    const loadElevations=async()=>{const {elevations}=await api('support/elevations');const body=document.querySelector('#elevation-rows');body.textContent='';for(const elevation of elevations){const row=document.createElement('tr');textCell(row,elevation.id);textCell(row,elevation.targetOrganizationId);textCell(row,elevation.scopes.join(', '));const status=textCell(row,'');const pill=document.createElement('span');pill.className='pill';pill.textContent=elevation.status;status.append(pill);textCell(row,new Date(elevation.expiresAt).toLocaleString());const actions=textCell(row,'');if(elevation.status==='pending'&&canApproveElevations&&elevation.operatorId!==bootstrap.operatorId){const approve=document.createElement('button');approve.type='button';approve.className='button';approve.textContent='Approve';approve.addEventListener('click',()=>elevationAction(elevation.id,'approve'));actions.append(approve)}if(elevation.status==='pending'||elevation.status==='active'){const revoke=document.createElement('button');revoke.type='button';revoke.className='button';revoke.textContent='Revoke';revoke.addEventListener('click',()=>elevationAction(elevation.id,'revoke'));actions.append(revoke)}body.append(row)}if(!elevations.length)body.innerHTML='<tr><td colspan="6" class="empty">No support elevations.</td></tr>'};
    const loadAudit=async()=>{const {events}=await api('audit');const list=document.querySelector('#audit-list');list.textContent='';for(const event of events.slice(0,8)){const item=document.createElement('div');item.className='audit-item';const title=document.createElement('div');title.textContent=event.eventType.replaceAll('_',' ');const meta=document.createElement('small');meta.textContent=new Date(event.occurredAt).toLocaleString()+' · '+event.correlationId;item.append(title,meta);list.append(item)}if(!events.length)list.innerHTML='<div class="empty">No audit events in this view.</div>'};
    Promise.allSettled([loadTenants(),loadHealth(),loadIncidents(),...(canAudit?[loadAudit()]:[]),...(canReadElevations?[loadElevations()]:[])]);
    document.querySelector('#elevation-form').addEventListener('submit',async(event)=>{event.preventDefault();const result=document.querySelector('#elevation-result');result.textContent='Requesting…';try{const response=await api('support/elevations',{method:'POST',body:JSON.stringify({targetOrganizationId:document.querySelector('#elevation-target').value,reason:document.querySelector('#elevation-reason').value,scopes:[document.querySelector('#elevation-scope').value],durationMinutes:Number(document.querySelector('#elevation-duration').value),kind:document.querySelector('#elevation-kind').value})});result.textContent='Elevation '+response.elevation.id+' created. '+(response.elevation.approvalRequired?'Approval required before use.':'Access granted until '+new Date(response.elevation.expiresAt).toLocaleString()+'.');await loadElevations()}catch{result.textContent='Access request was not completed.'}});
    document.querySelector('#lifecycle-form').addEventListener('submit',async(event)=>{event.preventDefault();const result=document.querySelector('#lifecycle-result');result.textContent='Saving…';try{await api('tenants/'+encodeURIComponent(document.querySelector('#lifecycle-target').value)+'/lifecycle',{method:'PATCH',body:JSON.stringify({lifecycleState:document.querySelector('#lifecycle-state').value,reason:document.querySelector('#lifecycle-reason').value})});result.textContent='Lifecycle updated and audited.';await loadTenants()}catch{result.textContent='Lifecycle update was not completed.'}});
    document.querySelector('#incident-form').addEventListener('submit',async(event)=>{event.preventDefault();const result=document.querySelector('#incident-result');result.textContent='Creating…';try{await api('incidents',{method:'POST',body:JSON.stringify({title:document.querySelector('#incident-title').value,summary:document.querySelector('#incident-summary').value,severity:document.querySelector('#incident-severity').value})});result.textContent='Incident created and audited.';await loadIncidents();await loadHealth()}catch{result.textContent='Incident was not created.'}});
    document.querySelector('#configuration-form').addEventListener('submit',async(event)=>{event.preventDefault();const result=document.querySelector('#configuration-result');result.textContent='Saving…';try{const value=JSON.parse(document.querySelector('#configuration-value').value);await api('configuration/'+encodeURIComponent(document.querySelector('#configuration-key').value),{method:'PUT',body:JSON.stringify({value,reason:document.querySelector('#configuration-reason').value})});result.textContent='Configuration updated and audited.'}catch{result.textContent='Configuration update was not completed.'}});
    document.querySelector('#sign-out').addEventListener('click',async()=>{await api('auth/logout',{method:'POST'}).catch(()=>undefined);location.assign('/api/v1/platform/auth/login?return=%2Fapi%2Fv1%2Fplatform%2Fui')});
  </script>
</body>
</html>`;
}
