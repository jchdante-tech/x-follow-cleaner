// A synthetic X-shaped page. No X data, cookies or network calls are used.
export const samplePeople = [
  {handle: 'new_one', id: '101', mutual: false},
  {handle: 'friend', id: '102', mutual: true},
  {handle: 'boundary', id: '103', mutual: false},
  {handle: 'old_one', id: '104', mutual: false},
  {handle: 'unknown', id: '105', unknown: true}
];

export function xPageFixture(config = {}) {
  const data = {people: samplePeople, owner: 'owner', lang: 'en', outcome: 'success', virtual: false, ...config};
  return `<!doctype html><html lang="${data.lang}"><meta charset="utf-8"><title>Local X fixture</title>
  <style>body{font:16px system-ui}main{height:400px;overflow-y:auto;border:1px solid #ccc}article{height:70px;box-sizing:border-box;padding:8px}a{display:inline-block;margin-right:10px}button{padding:6px}dialog,[role=dialog]{position:fixed;inset:20% 20% auto;background:white;padding:30px;border:2px solid} #list{position:relative}</style>
  <a data-testid="AppTabBar_Profile_Link" href="/${data.owner}">Profile</a><div data-testid="SideNav_AccountSwitcher_Button">Local Owner<br>@${data.owner}</div>
  <a href="/${data.owner}/following">${data.people.length} Following</a><main data-testid="primaryColumn"><div id="list"></div></main>
  <script>
  const cfg = ${JSON.stringify(data).replace(/</g, '\\u003c')};
  window.fixture = {clicked: [], confirmed: [], cancelled: 0, people: cfg.people};
  const area = document.querySelector('main'), list = document.getElementById('list');
  function addMarker(row) { const marker=document.createElement('span'); marker.dataset.testid='userFollowIndicator'; marker.textContent=cfg.lang.startsWith('zh')?'关注了你':'Follows you'; row.append(marker); }
  function render() {
    const start = cfg.virtual ? Math.floor(area.scrollTop / 70) : 0;
    const visible = cfg.virtual ? cfg.people.slice(start, start+9) : cfg.people;
    list.style.height = cfg.people.length*70+'px'; list.replaceChildren();
    for (const person of visible) {
      if(person.vanished) continue;
      const row = document.createElement('article'); row.dataset.testid='UserCell'; row.dataset.handle=person.handle;
      if(cfg.virtual) { row.style.position='absolute'; row.style.top=cfg.people.indexOf(person)*70+'px'; }
      const name=document.createElement('a');name.href='/'+person.handle;name.textContent=person.handle+' name';
      const handle=document.createElement('a');handle.href='/'+person.handle;handle.textContent='@'+person.handle;
      const button=document.createElement('button'); button.dataset.testid=person.unknown?'unknown-action':person.id+(person.removed?'-follow':'-unfollow');button.textContent=person.removed?'Follow':'Following';
      button.addEventListener('click',()=>{ if(person.removed)return; window.fixture.clicked.push(person.handle); showDialog(person); });
      row.append(name,handle,button);if(person.mutual)addMarker(row);list.append(row);
    }
  }
  function showDialog(person) {
    const dialog=document.createElement('div');dialog.setAttribute('role','dialog');
    const title=document.createElement('h2');title.textContent='Unfollow @'+(cfg.outcome==='mismatch'?'wrong_person':person.handle)+'?';
    const yes=document.createElement('button');yes.dataset.testid='confirmationSheetConfirm';yes.textContent='Unfollow';
    const no=document.createElement('button');no.dataset.testid='confirmationSheetCancel';no.textContent='Cancel';
    no.onclick=()=>{window.fixture.cancelled++;dialog.remove();};
    yes.onclick=()=>{
      window.fixture.confirmed.push(person.handle);dialog.remove();
      if(cfg.outcome==='rate-limit'){const alert=document.createElement('div');alert.setAttribute('role','alert');alert.textContent='Too many requests. Try again later.';document.body.append(alert);return;}
      if(cfg.outcome==='vanish')person.vanished=true;else if(cfg.outcome!=='unchanged')person.removed=true;
      render();
    };
    dialog.append(title,yes,no);document.body.append(dialog);
  }
  window.fixture.makeMutual=(handle)=>{cfg.people.find(p=>p.handle===handle).mutual=true;render();};
  area.addEventListener('scroll',()=>{if(cfg.virtual)render();});render();
  </script></html>`;
}
