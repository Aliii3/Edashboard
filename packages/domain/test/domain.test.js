import test from 'node:test';
import assert from 'node:assert';
import { Repo, Commands, Rule, calc, totals, integrity, driverCash, driverStats, stockOnHand, reservedOf, availableOf, paymentStatus, settlementStatus, collectionOutcome, linesOf, deliveryCash, activeDelivery, courierDeliveryBalance, round2, campaignSpend, contributionOf, allocationOf, orderValue, courierSummary, canRun, ROLE_SCREENS, COMMAND_ROLES } from '../src/index.js';
import { buildSeedWorkspace, runLoadTest } from '../src/seed.js';

test('permissions table only allows listed commands', () => {
  assert.equal(canRun('owner', '_newDelivery'), false);
  assert.equal(canRun('owner', 'constructor'), false);
  assert.equal(canRun('driver', 'refund'), false);
  assert.equal(canRun('warehouse', 'pickup'), true);
  for (const k in Commands) if (!k.startsWith('_')) assert.ok(Object.hasOwn(COMMAND_ROLES, k), `${k} needs a permission entry`);
});

test('business rules, money and scale', () => {
let pass=0,failN=0;const ok=(n,c,x='')=>{if(c)pass++;else{failN++;console.log('FAIL',n,x)}};
const throws=(n,fn,re)=>{try{fn();ok(n,false,'did not throw')}catch(e){if(!(e instanceof Rule))console.log('  non-rule:',e.stack);ok(n,!re||re.test(e.message),e.message)}};
let t=Date.now();buildSeedWorkspace();
const bad=integrity().filter(x=>!x.ok);ok('seed integrity',!bad.length,JSON.stringify(bad));
// === scenario tests
const cust=Repo.all('customers')[0];
const mk=(lines,x={})=>Commands.createOrder({customerId:cust.id,lines,channel:'Phone',...x});
const prep=o=>{Commands.confirmOrder(o.id);Commands.advanceOrder(o.id,'Processing');Commands.advanceOrder(o.id,'Ready')};
Commands.adjustStock({item:'TRS-BLK',itemType:'sku',qty:50,reason:'t'});Commands.adjustStock({item:'TEE-IVR',itemType:'sku',qty:50,reason:'t'});
// New order creates no revenue
let before=totals();let o=mk([{sku:'TRS-BLK',qty:2},{sku:'TEE-IVR',qty:1}],{discount:100,deliveryFee:50});
ok('new no rev',totals().revenue===before.revenue);ok('value',orderValue(o)===2*1150+490-100+50);
throws('no skip',()=>Commands.advanceOrder(o.id,'Ready'),/Processing/);
throws('assign before confirm',()=>Commands.assign(o.id,'driver','DRV-1'),/Confirm/);
let onh=stockOnHand('TRS-BLK'),res=reservedOf('TRS-BLK');Commands.confirmOrder(o.id);ok('reserve',reservedOf('TRS-BLK')===res+2&&stockOnHand('TRS-BLK')===onh);
throws('double confirm',()=>Commands.confirmOrder(o.id));
throws('assign before ready',()=>Commands.assign(o.id,'courier','BOSTA'),/Ready first/);Commands.advanceOrder(o.id,'Ready');ok('ready straight from confirmed',Repo.get('orders',o.id).status==='Ready');
let d=Commands.assign(o.id,'driver','DRV-1');throws('dup active',()=>Commands.assign(o.id,'driver','DRV-2'),/Already/);
let d2=Commands.reassign(d.id,'driver','DRV-2','zone');ok('prior closed',Repo.get('deliveries',d.id).status==='Cancelled Assignment');ok('one active',activeDelivery(o).id===d2.id);
Commands.pickup(d2.id);
ok('dispatch',stockOnHand('TRS-BLK')===onh-2&&reservedOf('TRS-BLK')===res);ok('order shipped',Repo.get('orders',o.id).status==='Shipped');
throws('reassign after pickup',()=>Commands.reassign(d2.id,'driver','DRV-3'),/pickup/);
throws('pickup twice',()=>Commands.pickup(d2.id));
Commands.setDeliveryStatus(d2.id,'Out for Delivery');Commands.setDeliveryStatus(d2.id,'Failed Attempt',{reason:'Customer refused'});
ok('failed custody stays',Repo.get('deliveries',d2.id).custody==='driver:DRV-2');ok('order failed',Repo.get('orders',o.id).status==='Failed Delivery');
throws('deliver from failed',()=>Commands.deliver(d2.id,{}),/Out for Delivery/);
Commands.setDeliveryStatus(d2.id,'Retry Scheduled',{retryAt:new Date().toISOString()});Commands.setDeliveryStatus(d2.id,'Out for Delivery');
let cashB=driverCash('DRV-2').outstanding;
const [l1,l2]=linesOf(o);
// partial: 1 of 2 trousers, tee delivered
let cRev=totals().revenue;
Commands.deliver(d2.id,{quantities:{[l1.id]:1,[l2.id]:1}});
let cO=calc(o);const netu1=(2300-100*2300/2790)/2,netu2=490-100*490/2790;
ok('partial revenue',Math.abs(cO.revenue-(netu1+netu2+50))<.02,cO.revenue);ok('partial cogs',cO.cogs===l1.unitCost+l2.unitCost);
ok('status partial',Repo.get('orders',o.id).status==='Partially Delivered');
ok('shortfall opened',Repo.by('discrepancies','orderId',o.id).some(x=>x.status==='Open'));
let due=round2(cO.revenue);
throws('over collect',()=>Commands.collect(d2.id,{amount:due+100,method:'Cash'}),/exceeds/);
throws('partial no reason',()=>Commands.collect(d2.id,{amount:100,method:'Cash'}),/reason/);
Commands.collect(d2.id,{amount:500,method:'Cash',shortReason:'short'});
ok('cash up',driverCash('DRV-2').outstanding===round2(cashB+500));
ok('pay partial',paymentStatus(o)==='Partially collected');
let nb=driverCash('DRV-2').outstanding;Commands.collect(d2.id,{amount:round2(due-500),method:'InstaPay',ref:'TEST-IPN-1'});
ok('noncash no driver',driverCash('DRV-2').outstanding===nb);ok('paid',paymentStatus(o)==='Paid',paymentStatus(o));
ok('shortfall closed',!Repo.by('discrepancies','orderId',o.id).some(x=>x.status==='Open'));
throws('dup ref',()=>{const x=mk([{sku:'TEE-IVR',qty:1}]);Commands.prepay(x.id,{amount:100,method:'Card',ref:'TEST-IPN-1'})},/already/);
// undelivered return
ok('custody partial',Repo.get('deliveries',d2.id).custody==='driver:DRV-2');
let on2=stockOnHand('TRS-BLK');Commands.startReturn(d2.id);ok('no stock yet',stockOnHand('TRS-BLK')===on2);Commands.receiveAtWarehouse(d2.id);ok('stock back',stockOnHand('TRS-BLK')===on2+1);
throws('double receive',()=>Commands.receiveAtWarehouse(d2.id));
// handover
let hb=driverCash('DRV-2'),bizB=totals().bizcash,revB=totals().revenue;
throws('excess alloc',()=>Commands.recordHandover({driverId:'DRV-2',ref:'T1',receivedBy:'x',allocations:[{deliveryId:d2.id,amount:501}]}),/unallocated/);
throws('dup in alloc',()=>Commands.recordHandover({driverId:'DRV-2',ref:'T1',receivedBy:'x',allocations:[{deliveryId:d2.id,amount:100},{deliveryId:d2.id,amount:100}]}),/twice/);
Commands.recordHandover({driverId:'DRV-2',ref:'T1',receivedBy:'x',allocations:[{deliveryId:d2.id,amount:300}]});
ok('held down',driverCash('DRV-2').outstanding===round2(hb.outstanding-300));ok('biz up',round2(totals().bizcash-bizB)===300);ok('no rev',totals().revenue===revB);
throws('dup ho ref',()=>Commands.recordHandover({driverId:'DRV-2',ref:'T1',receivedBy:'x',allocations:[{deliveryId:d2.id,amount:10}]}),/already/);
throws('re-alloc',()=>Commands.recordHandover({driverId:'DRV-2',ref:'T2',receivedBy:'x',allocations:[{deliveryId:d2.id,amount:300}]}),/unallocated/);
// customer return reverses, refund separate
let oc0=calc(o);let cs=Commands.openCase({orderId:o.id,type:'Return',items:[{lineId:l2.id,qty:1}],reason:'fit',returnCost:40});
ok('case no reversal yet',calc(o).revenue===oc0.revenue);
let onT=stockOnHand('TEE-IVR');Commands.acceptReturn(cs);ok('rev reversed',Math.abs(calc(o).revenue-(oc0.revenue-netu2))<.02);ok('cogs reversed',calc(o).cogs===l1.unitCost);ok('restock',stockOnHand('TEE-IVR')===onT+1);ok('cash unchanged',calc(o).collected===oc0.collected);
throws('accept twice',()=>Commands.acceptReturn(cs),/already/);
ok('refund review',paymentStatus(o)==='Refund review');
let owed=round2(calc(o).paid-calc(o).revenue);throws('over refund',()=>Commands.refund(o.id,{amount:owed+50,source:'business',ref:'RF1'}),/exceeds/);
let hb2=driverCash('DRV-2').outstanding,biz2=totals().bizcash;
Commands.refund(o.id,{amount:100,source:'driver:DRV-2',ref:'RF1'});ok('driver refund lowers',driverCash('DRV-2').outstanding===round2(hb2-100));ok('biz untouched',totals().bizcash===biz2);
Commands.refund(o.id,{amount:round2(owed-100),source:'business',ref:'RF2'});ok('refund biz',round2(biz2-totals().bizcash)===round2(owed-100));ok('paid after refund',paymentStatus(o)==='Paid',paymentStatus(o));
// driver-to-driver handover keeps cash with collector
let o3=mk([{sku:'TEE-IVR',qty:1}]);prep(o3);let d3=Commands.assign(o3.id,'driver','DRV-1');Commands.pickup(d3.id);let drv1=driverCash('DRV-1').outstanding,drv3=driverCash('DRV-3').outstanding;
let d4=Commands.driverHandover(d3.id,'DRV-3','swap');ok('custody moved',d4.custody==='driver:DRV-3'&&Repo.get('deliveries',d3.id).status==='Handed Over');ok('one active after',activeDelivery(o3).id===d4.id);
ok('cash unmoved',driverCash('DRV-1').outstanding===drv1&&driverCash('DRV-3').outstanding===drv3);
// expenses not double
let o4=mk([{sku:'TEE-IVR',qty:1}]);prep(o4);let d5=Commands.assign(o4.id,'driver','DRV-1');Commands.pickup(d5.id);Commands.setDeliveryStatus(d5.id,'Out for Delivery');Commands.deliver(d5.id,{collection:{amount:490,method:'Cash'}});
let dc=driverCash('DRV-1').outstanding;let pb=totals().profit;let ex=Commands.addDriverExpense({driverId:'DRV-1',category:'Delivery fee payout',amount:45,paidFromCash:true});Commands.decideDriverExpense(ex,'Approved');
ok('payout lowers cash',driverCash('DRV-1').outstanding===round2(dc-45));ok('payout no double P&L',totals().profit===pb);
let ex2=Commands.addDriverExpense({driverId:'DRV-1',category:'Fuel',amount:30,paidFromCash:false});Commands.decideDriverExpense(ex2,'Approved');ok('noncash exp no custody change',driverCash('DRV-1').outstanding===round2(dc-45));ok('fuel hits P&L',round2(pb-totals().profit)===30);
throws('handover over expense',()=>{const left=deliveryCash(d5).unhanded;const tot=driverCash('DRV-1').outstanding;Commands.recordHandover({driverId:'DRV-1',ref:'TX9',receivedBy:'x',allocations:Repo.by('deliveries','carrierKey','driver:DRV-1').map(q=>({deliveryId:q.id,amount:deliveryCash(q).unhanded})).filter(a=>a.amount>0)})},/exceeds/);
// courier: net settlement not double
let o5=mk([{sku:'TEE-IVR',qty:1}]);prep(o5);let d6=Commands.assign(o5.id,'courier','BOSTA');Commands.pickup(d6.id);Commands.setDeliveryStatus(d6.id,'Out for Delivery');Commands.deliver(d6.id,{collection:{amount:490,method:'Cash'}});
let b6=courierDeliveryBalance(d6);ok('courier exp net',b6.expectedNet===490-65-15,b6.expectedNet);
let prof=totals().profit,cashb=totals().bizcash;Commands.recordSettlement({courierId:'BOSTA',ref:'TST-1',allocations:[{deliveryId:d6.id,net:410}]});ok('settle no profit change',totals().profit===prof);ok('settle cash',round2(totals().bizcash-cashb)===410);ok('settled',settlementStatus(o5)==='Settled',settlementStatus(o5));
ok('contribution one deduction',calc(o5).delivery===65&&calc(o5).fees===15);
throws('settle ref dup',()=>Commands.recordSettlement({courierId:'BOSTA',ref:'TST-1',allocations:[{deliveryId:d6.id,net:1}]}),/already/);
// failed courier delivery keeps cost
let o6=mk([{sku:'TEE-IVR',qty:1}]);prep(o6);let d7=Commands.assign(o6.id,'courier','MYLERZ');Commands.pickup(d7.id);Commands.setDeliveryStatus(d7.id,'Out for Delivery');Commands.setDeliveryStatus(d7.id,'Failed Attempt',{reason:'Customer refused'});Commands.startReturn(d7.id);Commands.receiveAtWarehouse(d7.id);
ok('failed cost kept',calc(o6).delivery===60+45&&calc(o6).revenue===0&&Repo.get('orders',o6.id).status==='Returned');
// cancel releases
let o7=mk([{sku:'TEE-IVR',qty:3}]);Commands.confirmOrder(o7.id);let r7=reservedOf('TEE-IVR');Commands.cancelOrder(o7.id,'x');ok('release',reservedOf('TEE-IVR')===r7-3);
// production dup
let mo=Commands.createProduction({sku:'TOT-NAT',qty:5});let can=stockOnHand('FAB-CNV');Commands.startProduction(mo);ok('consume',stockOnHand('FAB-CNV')===round2(can-4));throws('start twice',()=>Commands.startProduction(mo));let tn=stockOnHand('TOT-NAT');Commands.completeProduction(mo);ok('receipt',stockOnHand('TOT-NAT')===tn+5);throws('complete twice',()=>Commands.completeProduction(mo));
// tx rollback
let ev=Repo.all('events').length,oc2=Repo.all('orders').length;throws('rollback',()=>Repo.tx(()=>{Commands.createOrder({customerId:cust.id,lines:[{sku:'TEE-IVR',qty:1}]});throw new Rule('boom')}));ok('rolled back',Repo.all('orders').length===oc2&&Repo.all('events').length===ev&&!Repo.get('orders',Math.max(...Repo.all('orders').map(x=>x.id))+1));
// campaign spend no orders
let c0=Commands.saveCampaign({name:'Empty',platform:'Meta',start:'2026-01-01',end:'2026-02-01',budget:100});let pp=totals();Commands.addSpend({campaignId:c0,amount:500});ok('unattributed spend hits profit',round2(pp.profit-totals().profit)===500);
// attribution change recalcs
let cA=Repo.all('campaigns')[0];let oA=Repo.by('orders','campaignId',cA.id)[0];let aB=allocationOf(oA);let oB=Repo.all('orders').find(x=>!x.campaignId&&x.status!=='Cancelled');Commands.attribute(oB.id,cA.id,'fix');ok('alloc recalculated',allocationOf(oA)<aB);
// inactive driver preserved + blocked
throws('inactive assign',()=>{let x=mk([{sku:'TEE-IVR',qty:1}]);prep(x);Commands.assign(x.id,'driver','DRV-6')},/inactive/);ok('history kept',driverStats('DRV-6').deliveries.length>=3);
// exchange credit
let o8=mk([{sku:'TEE-IVR',qty:1}]);prep(o8);let d8=Commands.assign(o8.id,'driver','DRV-1');Commands.pickup(d8.id);Commands.setDeliveryStatus(d8.id,'Out for Delivery');Commands.deliver(d8.id,{collection:{amount:490,method:'Cash'}});let x8=Commands.openCase({orderId:o8.id,type:'Exchange',items:[{lineId:linesOf(o8)[0].id,qty:1}],reason:'size'});throws('replacement before receive',()=>Commands.createReplacement(x8,{sku:'TEE-BLK',qty:1}),/Receive/);Commands.acceptReturn(x8);let col=totals().collected;let r8=Commands.createReplacement(x8,{sku:'TEE-BLK',qty:1});ok('credit moves',calc(r8).paid===490&&calc(o8).paid===0);ok('credit not cash',totals().collected===col);throws('replacement twice',()=>Commands.createReplacement(x8,{sku:'TEE-BLK',qty:1}),/already/);
const bad2=integrity().filter(x=>!x.ok);ok('final integrity',!bad2.length,JSON.stringify(bad2));
// load
t=Date.now();const r=runLoadTest(5000);console.log('load',JSON.stringify(r),'orders',Repo.all('orders').length,'ms',Date.now()-t);t=Date.now();const ib=integrity().filter(x=>!x.ok);console.log('integrity ms',Date.now()-t);ok('load integrity',!ib.length,JSON.stringify(ib));
console.log('bytes',JSON.stringify(Repo.data).length);
console.log(`pass ${pass} fail ${failN}`);assert.equal(failN,0,`${failN} checks failed`);

});

test('in-store sales, one-step shipping, tracking, attendance and product figures', async () => {
  const { WALK_IN, productStats, lateMinutes, dateKey, Clock } = await import('../src/index.js');
  buildSeedWorkspace();
  const throws = (fn, re) => assert.throws(fn, e => e instanceof Rule && (!re || re.test(e.message)), String(re));
  /* Seed ran the new commands without breaking any check. */
  assert.deepEqual(integrity().filter(x => !x.ok), []);
  assert.ok(Repo.all('deliveries').filter(d => d.mode === 'store').length >= 4, 'seed has store sales');
  assert.ok(Repo.all('attendance').length > 40, 'seed has attendance');

  /* A counter sale is delivered and paid at once, with the cash held by the business. */
  Commands.adjustStock({ item: 'TEE-IVR', itemType: 'sku', qty: 20, reason: 't' });
  const before = totals(), onHand = stockOnHand('TEE-IVR'), held = reservedOf('TEE-IVR');
  throws(() => Commands.storeSale({ lines: [{ sku: 'TEE-IVR', qty: 2 }], payments: [{ method: 'Cash', amount: 500 }] }), /paid in full/);
  assert.equal(stockOnHand('TEE-IVR'), onHand, 'a rejected sale changes nothing');
  const o = Commands.storeSale({ lines: [{ sku: 'TEE-IVR', qty: 2, discount: 80 }], discount: 100, payments: [{ method: 'Cash', amount: 500 }, { method: 'Card', amount: 300, ref: 'POS-T1' }] });
  assert.equal(o.status, 'Delivered'); assert.equal(o.channel, 'In-store'); assert.equal(o.customerId, WALK_IN);
  assert.equal(stockOnHand('TEE-IVR'), onHand - 2); assert.equal(reservedOf('TEE-IVR'), held, 'no reservation left behind');
  const c = calc(o);
  assert.equal(c.revenue, 800); assert.equal(c.collected, 800); assert.equal(paymentStatus(o), 'Paid'); assert.equal(settlementStatus(o), 'None'); assert.equal(collectionOutcome(o), 'Reconciled');
  assert.equal(round2(totals().revenue - before.revenue), 800);
  assert.equal(round2(totals().bizcash - before.bizcash), round2(800 - 300 * 0.025), 'money reaches the business at once, less the card fee');
  assert.equal(activeDelivery(o), undefined, 'no open delivery');
  assert.deepEqual(integrity().filter(x => !x.ok), []);
  /* A returning walk-in reuses the same customer; a phone number links a real customer. */
  const o2 = Commands.storeSale({ lines: [{ sku: 'TEE-IVR', qty: 1 }], payments: [{ method: 'Cash', amount: 490 }] });
  assert.equal(o2.customerId, WALK_IN); assert.equal(Repo.all('customers').filter(x => x.id === WALK_IN).length, 1);
  const known = Repo.all('customers')[4];
  assert.equal(Commands.storeSale({ customer: { phone: known.phone }, lines: [{ sku: 'TEE-IVR', qty: 1 }], payments: [{ method: 'InstaPay', amount: 490 }] }).customerId, known.id);
  /* Returns work like any delivered order. */
  const cs = Commands.openCase({ orderId: o2.id, type: 'Return', items: [{ lineId: linesOf(o2)[0].id, qty: 1 }], reason: 'size', returnCost: 0 });
  Commands.acceptReturn(cs); assert.equal(calc(o2).revenue, 0); Commands.refund(o2.id, { amount: 490, source: 'business', ref: 'RF-STORE-T' });
  assert.equal(paymentStatus(o2), 'Not due');
  throws(() => Commands.storeSale({ lines: [{ sku: 'SET-OAT', qty: 400 }], payments: [{ method: 'Cash', amount: 400 * 1650 }] }), /Not enough stock/);

  /* Ship in one step: assign, pickup and out for delivery. Ready is still required first. */
  const mk = () => Commands.createOrder({ customerId: Repo.all('customers')[1].id, lines: [{ sku: 'TEE-IVR', qty: 1 }], channel: 'Phone' });
  const s1 = mk(); Commands.confirmOrder(s1.id);
  throws(() => Commands.shipOrder(s1.id, 'driver', 'DRV-1', { then: 'out' }), /Ready first/);
  assert.equal(activeDelivery(s1), undefined, 'nothing assigned when shipping is refused');
  Commands.advanceOrder(s1.id, 'Ready');
  const sd = Commands.shipOrder(s1.id, 'driver', 'DRV-1', { then: 'out' });
  assert.equal(sd.status, 'Out for Delivery'); assert.equal(Repo.get('orders', s1.id).status, 'Shipped'); assert.equal(sd.custody, 'driver:DRV-1');
  const s2 = mk(); Commands.confirmOrder(s2.id); Commands.advanceOrder(s2.id, 'Ready');
  const cd = Commands.shipOrder(s2.id, 'courier', 'BOSTA', { tracking: '  BST-77  ', then: 'picked' });
  assert.equal(cd.status, 'Picked Up'); assert.equal(cd.tracking, 'BST-77');
  Commands.setTracking(cd.id, 'BST-78'); assert.equal(Repo.get('deliveries', cd.id).tracking, 'BST-78');
  throws(() => Commands.setTracking(cd.id, 'BST-78'), /already/);
  throws(() => Commands.setTracking(Repo.by('deliveries', 'orderId', o.id)[0].id, 'X'), /In-store/);

  /* Attendance: one record per person per day, replaced when recorded again. */
  const emp = Commands.saveEmployee({ name: 'Test Person', jobTitle: 'Packer', shiftStart: '09:00' });
  const today = dateKey(Clock.now());
  throws(() => Commands.saveEmployee({ name: 'Bad', shiftStart: '9am' }), /09:00/);
  throws(() => Commands.recordAttendance({ employeeId: emp, date: '2999-01-01', status: 'Present' }), /today or earlier/);
  throws(() => Commands.recordAttendance({ employeeId: emp, date: today, status: 'Present', checkIn: '17:00', checkOut: '09:00' }), /before check-in/);
  const id = Commands.recordAttendance({ employeeId: emp, date: today, status: 'Late', checkIn: '09:40' });
  assert.equal(lateMinutes(Repo.get('attendance', id)), 40);
  Commands.recordAttendanceDay(today, [{ employeeId: emp, status: 'Absent', checkIn: '09:00' }]);
  assert.equal(Repo.all('attendance').filter(a => a.employeeId === emp).length, 1);
  assert.equal(Repo.get('attendance', id).status, 'Absent'); assert.equal(Repo.get('attendance', id).checkIn, '', 'no times on an absent day');
  throws(() => Commands.recordAttendanceDay(today, [{ employeeId: emp, status: 'Present' }, { employeeId: emp, status: 'Absent' }]), /twice/);
  Commands.saveEmployee({ ...Repo.get('employees', emp), active: false });
  throws(() => Commands.recordAttendance({ employeeId: emp, date: dateKey(new Date(Date.now() - 864e5).toISOString()), status: 'Present' }), /inactive/);
  Commands.removeAttendance(id); assert.equal(Repo.get('attendance', id), undefined);

  /* Product figures add up to the ledger: revenue from items kept, after every discount. */
  const fromProducts = Repo.all('skus').reduce((t, s) => t + productStats(s.id).revenue, 0);
  const fees = Repo.all('orders').reduce((t, x) => t + calc(x).entries.filter(e => e.acct === 'revenue' && e.tag === 'fee').reduce((a, e) => a + e.amt, 0), 0);
  assert.equal(round2(fromProducts + fees), totals().revenue);
  const ps = productStats('TEE-IVR'); assert.ok(ps.kept > 0 && ps.channels.get('In-store').units >= 2);
});
