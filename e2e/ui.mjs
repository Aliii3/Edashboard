import fs from 'node:fs';
export async function runUi({chromium,URL,SHOT,PW,chrome}){
 const b=await chromium.launch(chrome?{executablePath:chrome}:{});const ctx=await b.newContext({viewport:{width:1440,height:900},acceptDownloads:true});const p=await ctx.newPage();
 const errs=[];p.on('pageerror',e=>errs.push('PAGE '+e.message));p.on('console',m=>{if(m.type()==='error'){if(!/status of (401|422|403)/.test(m.text()))errs.push('CONSOLE '+m.text())}});
 const rawWait=p.waitForTimeout.bind(p);p.waitForTimeout=ms=>rawWait(ms+120);
 const signIn=async(pg,email)=>{await pg.goto(URL);await pg.waitForSelector('#loginForm');await pg.fill('input[name=email]',email);await pg.fill('input[name=password]',PW);await pg.click('#loginForm button');await pg.waitForFunction(()=>document.querySelector('#main .heading'))};
 await p.goto(URL);await p.waitForSelector('#loginForm');await p.fill('input[name=email]','owner@nilestudio.example');await p.fill('input[name=password]','wrong-password');await p.click('#loginForm button');await p.waitForSelector('#loginError:not(:empty)');
 await signIn(p,'owner@nilestudio.example');await shot0();
 let pass=0,fail=0;const ok=(n,c,x='')=>{if(c)pass++;else{fail++;console.log('FAIL',n,x)}};
 async function shot0(){await p.screenshot({path:`${SHOT}/login-done.png`})}
 const go=async h=>{await p.evaluate(h=>{location.hash=h},h);await p.waitForTimeout(40)};
 const shot=n=>p.screenshot({path:`${SHOT}/${n}.png`,fullPage:false});
 const toast=()=>p.locator('#toast').innerText();
 const clickBtn=(t,scope='#main')=>p.locator(`${scope} button:visible`,{hasText:t}).first().click();
 const ev=f=>p.evaluate(f);
 // every screen and tab renders non-empty
 for(const n of ['overview','orders','order360','crm','inventory','shipping','finance','campaigns','settings','roadmap']){await go('#/'+n);const t=await p.locator('#main h1').first().innerText();ok('screen '+n,t.length>0);await shot('s-'+n)}
 for(const [hash,tabs] of [['#/inventory',['Finished goods','Raw materials','Production','BOM & costing','Reservations','Movement journal']],['#/shipping',['Dispatch queue','External couriers','Private delivery','Failed follow-up','Returns & exchanges']],['#/finance',['Profit & loss','Courier reconciliation','Driver reconciliation','Operating expenses','Customer collections','Business cash & refunds','Closed periods']],['#/settings',['Workspace','Operational rules','Drivers & couriers','Data sources','Roles','Activity history','Data & scale','Limitations']]]){await go(hash);for(const t of tabs){await p.locator('.tabs button',{hasText:t}).first().click();await p.waitForTimeout(30);ok(`tab ${hash} ${t}`,(await p.locator('#main').innerText()).length>100);const name=(hash+t).replace(/[^a-z]/gi,'');await shot('t-'+name)}}
 // Integrity on screen
 await go('#/settings');await p.locator('.tabs button',{hasText:'Data & scale'}).click();ok('checks pass ui',(await p.locator('#main').innerText()).includes('checks pass'));
 // New multi-line order
 await go('#/orders');const before=await ev(()=>Repo.all('orders').length);
 await clickBtn('+ New order');await p.waitForSelector('dialog[open]');await shot('m-neworder');
 const cn=await ev(()=>{const c=Repo.all('customers')[3];return `${c.id} · ${c.name} · ${c.phone}`});
 await p.fill('input[name=customerPick]',cn);await p.click('[data-dl-add]');await p.selectOption('[data-dl=sku][data-i="1"]','TOT-NAT');await p.fill('[data-dl=qty][data-i="0"]','2');await p.locator('[data-dl=qty][data-i="0"]').blur();await p.fill('input[name=deliveryFee]','50');await p.locator('input[name=deliveryFee]').blur();
 ok('draft total',(await p.locator('#draftTotal').innerText()).includes('2,180'),await p.locator('#draftTotal').innerText());
 await p.click('dialog button[type=submit]');await p.waitForTimeout(100);
 ok('order created',await ev(()=>Repo.all('orders').length)===before+1);ok('routes to order',(await p.evaluate(()=>location.hash)).startsWith('#/orders/'));
 const oid=await ev(()=>Number(location.hash.split('/')[2]));
 ok('no revenue',await ev(`calc(orderOf(${oid})).revenue`)===0);
 await p.waitForTimeout(50);
 ok('why unavailable',(await p.locator('.whynot').first().innerText()).includes('unavailable'));
 await clickBtn('Confirm and reserve');await p.waitForTimeout(60);ok('confirmed',await ev(`orderOf(${oid}).status`)==='Confirmed');
 await clickBtn('Start processing');await p.waitForTimeout(60);await clickBtn('Mark ready');await p.waitForTimeout(60);
 await clickBtn('Assign delivery');await p.waitForSelector('dialog[open]');await p.selectOption('select[name=mode]','driver');await p.selectOption('select[name=driver]','DRV-1');await p.click('dialog button[type=submit]');await p.waitForTimeout(80);
 const did=await ev(`activeDelivery(orderOf(${oid})).id`);ok('assigned',!!did);
 ok('driver link',await p.locator('#main a[href="#/drivers/DRV-1"]').count()>0);
 await shot('o-360');
 await clickBtn('Record pickup');await p.waitForTimeout(60);await clickBtn('Out for delivery');await p.waitForTimeout(60);
 await clickBtn('Failed attempt');await p.waitForSelector('dialog[open]');await p.click('dialog button[type=submit]');await p.waitForTimeout(60);
 ok('failed custody',await ev(`Repo.get('deliveries','${did}').custody`)==='driver:DRV-1');
 await clickBtn('Schedule retry');await p.waitForSelector('dialog[open]');await p.click('dialog button[type=submit]');await p.waitForTimeout(60);
 await clickBtn('Out for delivery');await p.waitForTimeout(60);
 await clickBtn('Record delivery');await p.waitForSelector('dialog[open]');await shot('m-deliver');
 const line1=await ev(`linesOf(orderOf(${oid}))[0].id`);
 await p.fill(`input[name="q${line1}"]`,'1');await p.locator(`input[name="q${line1}"]`).blur();await p.waitForTimeout(30);
 const amt=await p.inputValue('input[name=amount]');ok('live expected',Number(amt)===890+350+50,amt);
 await p.fill('input[name=amount]','1000');await p.fill('input[name=reason]','Customer kept one, short on cash');await p.click('dialog button[type=submit]');await p.waitForTimeout(80);
 ok('partial',await ev(`orderOf(${oid}).status`)==='Partially Delivered',await ev(`orderOf(${oid}).status`));ok('rev',await ev(`calc(orderOf(${oid})).revenue`)===1290);ok('collected',await ev(`calc(orderOf(${oid})).collected`)===1000);ok('short',await ev(`paymentStatus(orderOf(${oid}))`)==='Partially collected');
 // Driver profile
 await go('#/shipping');await p.locator('.tabs button',{hasText:'Private delivery'}).click();await shot('d-directory');ok('driver cards',await p.locator('.driver-card').count()===6);
 await p.locator('.driver-card a',{hasText:'Mahmoud Fawzy'}).click();await p.waitForTimeout(80);ok('profile route',(await ev(()=>location.hash))==='#/drivers/DRV-1');ok('custody heading',(await p.locator('#main').innerText()).includes('Currently with this driver'));ok('delivery shows in custody',(await p.locator('.prominent').innerText()).includes(did));await shot('d-profile');
 const heldB=await ev(`driverCash('DRV-1').outstanding`);ok('held 1000',heldB===1000,heldB);
 await p.locator('.tabs button',{hasText:'Cash'}).click();await p.waitForTimeout(40);await shot('d-cash');
 await clickBtn('Record cash handover');await p.waitForSelector('dialog[open]');await shot('m-handover');
 await p.fill('input[name=ref]','HO-UI-1');await p.locator('[data-alloc]').first().fill('600');await p.locator('[data-alloc]').first().blur();await p.click('dialog button[type=submit]');await p.waitForTimeout(80);
 ok('handover partial',await ev(`driverCash('DRV-1').outstanding`)===400);
 await clickBtn('Record cash handover');await p.waitForSelector('dialog[open]');await p.fill('input[name=ref]','HO-UI-1');await p.click('dialog button[type=submit]');await p.waitForTimeout(40);ok('dup ref msg',(await p.locator('#formError').innerText()).includes('already exists'));
 await p.fill('input[name=ref]','HO-UI-2');await p.locator('[data-alloc]').first().fill('5000');await p.click('dialog button[type=submit]');await p.waitForTimeout(40);ok('excess blocked',(await p.locator('#formError').innerText()).length>0,await p.locator('#formError').innerText());await p.click('dialog [data-close]');
 // consistency across screens
 await go('#/finance');await p.locator('.tabs button',{hasText:'Driver reconciliation'}).click();await p.waitForTimeout(40);ok('finance shows driver',(await p.locator('#main').innerText()).includes('EGP 400'));
 // Delivery details modal
 await go(`#/orders/${oid}`);await p.waitForTimeout(60);await p.locator('#main .delivery .link').first().click();await p.waitForSelector('dialog[open]');await shot('m-delivery');await p.click('dialog [data-close]');
 // Return undelivered unit
 await clickBtn('Start return');await p.waitForTimeout(60);await clickBtn('Receive at warehouse');await p.waitForTimeout(60);ok('rtw',await ev(`Repo.get('deliveries','${did}').status`)==='Returned to Warehouse');
 // Customer return + refund
 await clickBtn('Open return');await p.waitForSelector('dialog[open]');const line2=await ev(`linesOf(orderOf(${oid}))[1].id`);await p.fill(`input[name="q${line2}"]`,'1');await p.fill('input[name=reason]','Did not fit');await p.click('dialog button[type=submit]');await p.waitForTimeout(80);
 await clickBtn('Accept item');await p.waitForTimeout(80);ok('return reversal',await ev(`calc(orderOf(${oid})).revenue`)===940,await ev(`calc(orderOf(${oid})).revenue`));ok('still collected',await ev(`calc(orderOf(${oid})).collected`)===1000);
 await clickBtn('Refund');await p.waitForSelector('dialog[open]');await p.fill('input[name=ref]','RF-UI');await p.click('dialog button[type=submit]');await p.waitForTimeout(80);ok('refund',await ev(`paymentStatus(orderOf(${oid}))`)==='Paid',await ev(`paymentStatus(orderOf(${oid}))`));
 // financial explain
 await p.locator('details.ex summary').first().click();ok('explain opens',(await p.locator('details.ex[open] .ex-body').first().innerText()).length>10);
 // persistence
 await p.waitForTimeout(500);await p.reload();await p.waitForFunction(()=>window.Repo&&document.querySelector('#main .heading'));ok('persisted',await ev(`orderOf(${oid}).status`)==='Partially Returned',await ev(`orderOf(${oid})?.status`));
 // orders: filters, sort, search, csv export
 await go('#/orders');await p.selectOption('[data-f="orders.status"]','Delivered');await p.waitForTimeout(60);const cnt=await ev(()=>filteredOrders().length);ok('filter',cnt>0&&await ev(()=>filteredOrders().every(o=>o.status==='Delivered')));
 const [dl]=await Promise.all([p.waitForEvent('download'),clickBtn('Export filtered CSV')]);const csv=fs.readFileSync(await dl.path(),'utf8');ok('csv rows',csv.trim().split('\r\n').length===cnt+1);
 await p.locator('th button',{hasText:'Value'}).click();await p.waitForTimeout(50);
 await p.selectOption('[data-f="orders.status"]','');await p.fill('[data-f="orders.q"]','TOT-NAT');await p.waitForTimeout(280);ok('search keeps focus',await ev(()=>document.activeElement?.id==='s-orders.q'));await p.fill('[data-f="orders.q"]','');await p.waitForTimeout(280);
 // bulk
 await p.selectOption('[data-f="orders.status"]','New');await p.waitForTimeout(60);const ids=await p.locator('[data-sel]').count();if(ids){await p.locator('thead input[type=checkbox]').check();await p.waitForTimeout(40);await clickBtn('Confirm');await p.waitForTimeout(120);ok('bulk ran',await ev(()=>ui.selected.size===0))}
 if(await p.locator('dialog[open]').count())await p.click('dialog [data-close]');
 await ev(()=>{ui.orders=blankOrderFilters();render()});
 // CSV import
 await clickBtn('Import CSV');await p.waitForSelector('dialog[open]');
 const csvIn='external_ref,date,customer_phone,customer_name,area,address,sku,qty\nWEB-1,2026-11-01,01099990001,Reem Fouad,Maadi,"12 Road 9, Maadi",TEE-IVR,2\nWEB-1,2026-11-01,01099990001,Reem Fouad,Maadi,"12 Road 9, Maadi",TOT-NAT,1\nWEB-2,bad,123,,,,NOPE,0\n';fs.writeFileSync(SHOT+'/in.csv',csvIn);
 await p.setInputFiles('#csvFile',SHOT+'/in.csv');await p.waitForSelector('#importPreview table');const pv=await p.locator('#importPreview').innerText();ok('csv preview',pv.includes('1 valid order')&&pv.includes('invalid customer_phone'),pv);await shot('m-import');
 const b4=await ev(()=>Repo.all('orders').length);await p.click('dialog button[type=submit]');await p.waitForTimeout(100);ok('csv imported',await ev(()=>Repo.all('orders').length)===b4+1);ok('csv lines',await ev(()=>linesOf(Repo.all('orders').at(-1)).length)===2);ok('csv source',await ev(()=>Repo.all('orders').at(-1).source)==='CSV');
 await clickBtn('Import CSV');await p.waitForSelector('dialog[open]');await p.setInputFiles('#csvFile',SHOT+'/in.csv');await p.waitForTimeout(100);ok('csv dup blocked',(await p.locator('#importPreview').innerText()).includes('already imported'));await p.click('dialog [data-close]');
 // production
 await go('#/inventory');await p.locator('.tabs button',{hasText:'Production'}).click();await p.waitForTimeout(40);const mp=await ev(()=>Repo.all('production').find(x=>x.status==='Planned').id);await clickBtn('Start and consume');await p.waitForTimeout(60);ok('mo wip',await ev(`Repo.get('production','${mp}').status`)==='WIP');const sku=await ev(`Repo.get('production','${mp}').sku`);const on=await ev(`stockOnHand('${sku}')`);await p.locator('tr',{hasText:mp}).locator('button',{hasText:'Complete'}).click();await p.waitForTimeout(60);ok('mo done',await ev(`stockOnHand('${sku}')`)>on);
 // campaign recalculation + empty campaign
 await go('#/campaigns');await p.waitForTimeout(40);const prof=await ev(()=>totals().profit);await p.locator('tr',{hasText:'Winter teaser'}).locator('button',{hasText:'Add spend'}).click();await p.waitForSelector('dialog[open]');await p.fill('input[name=amount]','100');await p.click('dialog button[type=submit]');await p.waitForTimeout(60);ok('empty spend hits profit',Math.abs(await ev(()=>totals().profit)-(prof-100))<.01);await shot('s-campaigns2');
 // courier settlement
 await go('#/finance');await p.locator('.tabs button',{hasText:'Courier reconciliation'}).click();await p.waitForTimeout(40);await clickBtn('Record Bosta settlement');await p.waitForSelector('dialog[open]');await p.fill('input[name=ref]','BST-UI-1');await shot('m-settle');await p.click('dialog button[type=submit]');await p.waitForTimeout(80);ok('settlement',await ev(()=>Repo.count('settlements','ref','BST-UI-1'))===1);
 // new driver + availability
 await go('#/shipping');await p.locator('.tabs button',{hasText:'Private delivery'}).click();await clickBtn('+ New driver');await p.waitForSelector('dialog[open]');await p.fill('input[name=name]','Test Driver');await p.fill('input[name=phone]','123');await p.click('dialog button[type=submit]');await p.waitForTimeout(40);ok('phone validated',(await p.locator('#formError').innerText()).includes('Egyptian'));await p.fill('input[name=phone]','01033334444');await p.click('dialog button[type=submit]');await p.waitForTimeout(100);ok('driver made',(await ev(()=>location.hash)).startsWith('#/drivers/DRV-7'));
 // global search
 await p.fill('#dock input','Mahmoud');await p.waitForTimeout(40);ok('global search',(await p.locator('#searchResults').innerText()).includes('Mahmoud'));await p.locator('#searchResults a').first().click();await p.waitForTimeout(60);
 // integrity after everything
 const bad=await ev(()=>integrity().filter(x=>!x.ok));ok('integrity after flows',!bad.length,JSON.stringify(bad));
 // close the books from Finance, check the figures are recorded, then reopen as owner
 await go('#/finance');await p.locator('.tabs button',{hasText:'Closed periods'}).click();await clickBtn('Close books…');await p.waitForSelector('dialog[open]');await p.click('dialog button[type=submit]');await p.waitForTimeout(150);
 ok('books closed',!!(await ev(()=>S().lockedThrough)),await toast());ok('closing figures shown',(await p.locator('#main').innerText()).includes('Figures at closing vs now'));
 ok('closing check passes',await ev(()=>integrity().every(x=>x.ok)&&integrity().some(x=>x.name.startsWith('Closed books'))));await shot('fin-closed');
 await clickBtn('Reopen…');await p.waitForSelector('dialog[open]');await p.fill('dialog textarea[name=reason]','E2E correction');await p.click('dialog button[type=submit]');await p.waitForTimeout(150);
 ok('books reopened',!(await ev(()=>S().lockedThrough)));ok('period history',(await p.locator('#main').innerText()).includes('E2E correction'));
 // two people at once: a second staff member sees changes live, without reloading
 const ctx2=await b.newContext({viewport:{width:1280,height:800}});const q=await ctx2.newPage();q.on('pageerror',e=>errs.push('PAGE2 '+e.message));await signIn(q,'ops@nilestudio.example');
 ok('ops nav hides finance',await q.locator('nav a[href="#/finance"]').count()===0);ok('ops nav hides settings',await q.locator('nav a[href="#/settings"]').count()===0);await q.evaluate(()=>{location.hash='#/finance'});await q.waitForTimeout(150);ok('ops blocked from finance',(await q.evaluate(()=>location.hash))!=='#/finance');
 ok('ops nav hides campaigns',await q.locator('nav a[href="#/campaigns"]').count()===0);ok('ops gets no expenses or spend',await q.evaluate(()=>Repo.all('expenses').length+Repo.all('spend').length)===0);ok('ops gets no unit costs',await q.evaluate(()=>Repo.all('lines').every(l=>!l.unitCost)));
 await q.evaluate(()=>{location.hash='#/overview'});await q.waitForTimeout(150);ok('ops overview hides profit',!(await q.locator('#main').innerText()).includes('Profit summary'));
 await q.evaluate(()=>{location.hash='#/orders'});await q.waitForTimeout(150);ok('ops orders hide contribution',!(await q.locator('#main thead').first().innerText()).includes('Contribution'));
 await go('#/orders');const nb=await q.evaluate(()=>Repo.all('orders').length);await p.evaluate(()=>{});await clickBtn('+ New order');await p.waitForSelector('dialog[open]');await p.fill('input[name=customerPick]',cn);await p.click('dialog button[type=submit]');await p.waitForTimeout(150);await q.waitForFunction(n=>Repo.all('orders').length===n+1,nb,{timeout:15000});ok('update reached second user by polling',true);
 // driver login sees only their own work
 const ctx3=await b.newContext({viewport:{width:390,height:844}});const r=await ctx3.newPage();r.on('pageerror',e=>errs.push('PAGE3 '+e.message));await signIn(r,'driver@nilestudio.example');ok('driver lands on own profile',(await r.evaluate(()=>location.hash))==='#/drivers/DRV-1');ok('driver nav single',await r.locator('nav a').count()===1);ok('driver one record',await r.evaluate(()=>Repo.all('drivers').length)===1);ok('driver no money tools',await r.locator('button',{hasText:'Record cash handover'}).count()===0);await r.screenshot({path:`${SHOT}/driver-mobile.png`});
 await r.evaluate(()=>{location.hash='#/drivers/DRV-3'});await r.waitForTimeout(200);ok('driver cannot open another',(await r.evaluate(()=>location.hash))==='#/drivers/DRV-1');await r.evaluate(()=>{location.hash='#/finance'});await r.waitForTimeout(200);ok('driver cannot open finance',(await r.evaluate(()=>location.hash))==='#/drivers/DRV-1');
 const cur=await r.evaluate(()=>{const d=Repo.by('deliveries','carrierKey','driver:DRV-1').find(x=>x.status==='Out for Delivery');return d?.id});if(cur){await r.locator('tr',{hasText:cur}).first().locator('button',{hasText:'Record delivery'}).first().click();await r.waitForSelector('dialog[open]');await r.click('dialog button[type=submit]');await r.waitForTimeout(300);ok('driver recorded delivery',await r.evaluate(c=>Repo.get('deliveries',c).status,cur)==='Delivered');await p.waitForFunction(c=>Repo.get('deliveries',c).status==='Delivered',cur,{timeout:15000});ok('office sees driver update',true)}
 await ctx2.close();await ctx3.close();
 // sign out, and data is still there after signing back in
 await p.click('#accountBtn');await p.waitForSelector('dialog[open]');await p.locator('dialog button',{hasText:'Sign out'}).click();await p.waitForSelector('#loginForm');ok('signed out',(await p.request.get(URL+'api/me')).status()===401);await signIn(p,'owner@nilestudio.example');
 // scale
 const lt=await p.evaluate(async()=>{const r=await fetch('/api/admin/load-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orders:5000})});return r.json()});console.log('5k load test: generate + save to PostgreSQL',Math.round(lt.totalMs),'ms');ok('load test ran',lt.orders>5000,JSON.stringify(lt).slice(0,200));
 const t1=Date.now();await p.reload();await p.waitForFunction(()=>window.Repo&&Repo.data&&Repo.all('orders').length>5000&&document.querySelector('#main .heading'),null,{timeout:60000});console.log('page load with 5k orders (paged download)',Date.now()-t1,'ms');
 const timing=async(h)=>ev2(h);const ev2=h=>p.evaluate(h=>{location.hash=h;Repo.touch();const t=performance.now();render();return performance.now()-t},h);
 for(const h of ['#/overview','#/orders','#/crm','#/shipping','#/finance','#/campaigns','#/drivers/DRV-1']){console.log(h,Math.round(await timing(h)),'ms')}
 const badL=await ev(()=>integrity().filter(x=>!x.ok));ok('integrity at scale',!badL.length,JSON.stringify(badL));
 // reset
 await go('#/settings');await p.locator('.tabs button',{hasText:'Data & scale'}).click();await clickBtn('Reset demo data');await p.waitForSelector('dialog[open]');await p.click('dialog button[type=submit]');await p.waitForTimeout(150);ok('reset',await ev(()=>Repo.all('orders').length)<300);
 // mobile
 await p.setViewportSize({width:390,height:844});for(const h of ['#/overview','#/orders','#/drivers/DRV-2','#/finance','#/shipping']){await go(h);await p.waitForTimeout(50);const over=await ev(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);ok('no h-scroll '+h,over<=0,over);await shot('mob-'+h.replace(/\W/g,''))}
 console.log('errors',errs.slice(0,10));ok('no console errors',errs.length===0);
 console.log(`pass ${pass} fail ${fail}`);await b.close();return fail;
}
