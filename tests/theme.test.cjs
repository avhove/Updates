const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const read = file => readFileSync(resolve(__dirname,'../fleetdeck/static',file),'utf8');
async function header({mobile=true,login=true,menu=true}={}) {
  const { window } = parseHTML(read('index.html'));
  const document = window.document, listeners=[],calls=[];
  if (!menu) document.querySelector('.dashboard-menu-session').remove();
  const narrow={matches:mobile,addEventListener:(_,cb)=>listeners.push(cb)};
  let ready;
  const location={hostname:'localhost',protocol:'http:',pathname:'/',href:'/'};
  vm.runInNewContext(read('theme.js'),{document,location,localStorage:{getItem:()=>null,setItem:()=>{}},
    matchMedia:q=>q==='(max-width: 520px)'?narrow:{matches:false},addEventListener:(_,cb)=>{ready=cb;},
    fetch:async(path,options)=>{calls.push({path,options});return{json:async()=>({login,username:'<admin>'})};}});
  ready();await new Promise(setImmediate);
  return {document,calls,location,resize:mobile=>{narrow.matches=mobile;listeners.forEach(cb=>cb());}};
}
test('phone header moves theme and authenticated sign-out into More and restores them on resize',async()=>{
  const ui=await header(),doc=ui.document;
  assert.equal(doc.querySelectorAll('header .toolbar > button.icon').length,0);
  const actions=doc.querySelectorAll('.dashboard-menu-session button');
  assert.equal(actions.length,2);
  assert.match(actions[0].textContent,/Switch to dark theme/);
  assert.equal(actions[1].querySelector('span').textContent,'Sign out (<admin>)');
  assert.equal(doc.querySelector('.dashboard-menu-session admin'),null);
  actions[0].onclick();assert.equal(doc.documentElement.dataset.theme,'dark');
  assert.match(actions[0].textContent,/Switch to light theme/);
  ui.resize(false);
  assert.equal(doc.querySelectorAll('header .toolbar > button.icon').length,2);
  assert.equal(doc.querySelector('.dashboard-menu-session').children.length,0);
  assert.equal(actions[0].querySelector('span'),null);
  ui.resize(true);assert.equal(doc.querySelector('.dashboard-menu-session').children.length,2);
  await actions[1].onclick();assert.equal(ui.location.href,'/login');
  assert.equal(ui.calls.at(-1).path,'/api/logout');assert.equal(ui.calls.at(-1).options.method,'POST');
});
test('theme remains available without a login and other page toolbars keep their existing controls',async()=>{
  const anonymous=await header({login:false});
  assert.equal(anonymous.document.querySelectorAll('.dashboard-menu-session button').length,1);
  const other=await header({menu:false});
  assert.equal(other.document.querySelectorAll('header .toolbar > button.icon').length,2);
});
