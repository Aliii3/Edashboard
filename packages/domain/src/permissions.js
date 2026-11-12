/* Who may run each command, and who may open each screen. The server enforces
   COMMAND_ROLES on every request. The web app reads the same table to hide what
   a user can't do, so the two can never disagree. */
export const ROLES = ['owner', 'operations', 'warehouse', 'finance', 'driver'];
const OPS = 'operations', WH = 'warehouse', FIN = 'finance', DRV = 'driver';
export const COMMAND_ROLES = {
  createOrder: [OPS], createOrderWithCustomer: [OPS], importOrders: [OPS], addOrderNote: [OPS, WH, FIN], confirmOrder: [OPS], advanceOrder: [OPS, WH], cancelOrder: [OPS],
  attribute: [FIN],
  assign: [OPS], shipOrder: [OPS], setTracking: [OPS, WH], storeSale: [OPS], reassign: [OPS], driverHandover: [OPS], pickup: [OPS, WH], setDeliveryStatus: [OPS, DRV], deliver: [OPS, DRV], collect: [OPS, FIN, DRV], prepay: [OPS, FIN], startReturn: [OPS, DRV], receiveAtWarehouse: [OPS, WH],
  recordHandover: [FIN], addDriverExpense: [OPS, FIN, DRV], decideDriverExpense: [FIN], resolveDiscrepancy: [FIN], recordSettlement: [FIN], refund: [FIN],
  openCase: [OPS], acceptReturn: [OPS, WH], rejectCase: [OPS, WH], createReplacement: [OPS], closeCase: [OPS, FIN],
  adjustStock: [OPS, WH], createProduction: [OPS, WH], startProduction: [OPS, WH], completeProduction: [OPS, WH], cancelProduction: [OPS, WH], saveSku: [OPS], receiveMaterial: [OPS, WH],
  saveCustomer: [OPS], setCustomerTags: [OPS], logContact: [OPS, FIN],
  saveCampaign: [FIN], addSpend: [FIN], addExpense: [FIN], removeExpense: [FIN],
  saveDriver: [OPS], setAvailability: [OPS], saveCourier: [], saveSettings: [], setRoadmap: [],
  closePeriod: [FIN], reopenPeriod: [],
  saveEmployee: [OPS], recordAttendance: [OPS], recordAttendanceDay: [OPS], removeAttendance: [OPS],
};
/* The owner may run everything in the table. Anything not in the table can't be called at all. */
export const canRun = (role, command) => Object.hasOwn(COMMAND_ROLES, command) && (role === 'owner' || COMMAND_ROLES[command].includes(role));
/* Commands a driver may run, and how to find the driver they must belong to. */
export const DRIVER_SCOPE = { setDeliveryStatus: 'delivery', deliver: 'delivery', collect: 'delivery', startReturn: 'delivery', addDriverExpense: 'driverField' };
export const ROLE_SCREENS = {
  owner: ['overview', 'orders', 'order360', 'crm', 'products', 'inventory', 'shipping', 'driver', 'finance', 'campaigns', 'staff', 'settings', 'roadmap'],
  operations: ['overview', 'orders', 'order360', 'crm', 'products', 'inventory', 'shipping', 'driver', 'staff'],
  warehouse: ['orders', 'order360', 'products', 'inventory', 'shipping', 'driver'],
  finance: ['overview', 'orders', 'order360', 'crm', 'products', 'driver', 'shipping', 'finance', 'campaigns', 'staff'],
  driver: ['driver'],
};

/* What each role may read. The server removes everything else before data leaves
   the database, so hidden figures never reach the browser.
   Owner and finance see costs and profit. Operations and warehouse see prices and
   collections, but not product costs, profit, campaign spend or company expenses.
   Warehouse also doesn't see the customer contact log or staff attendance. Drivers get their own
   deliveries only (see the driver snapshot on the server). */
export const COST_ROLES = ['owner', 'finance'];
export const seesCosts = role => COST_ROLES.includes(role);
const COST_FIELDS = { lines: ['unitCost'], materials: ['cost'], boms: ['labor', 'overhead'], production: ['unitCost'], campaigns: ['budget', 'reportedRoas'] };
const HIDDEN_TABLES = { operations: ['spend', 'expenses'], warehouse: ['spend', 'expenses', 'contacts', 'employees', 'attendance'], driver: ['spend', 'expenses', 'contacts', 'settlements', 'settlementAllocs', 'campaigns', 'materials', 'boms', 'production', 'movements', 'couriers', 'employees', 'attendance'] };
export const canReadTable = (role, table) => !(HIDDEN_TABLES[role] || []).includes(table);
/* Returns the row as this role may see it, or null when the role may not see it at all. */
export function redactRow(role, table, row) {
  if (seesCosts(role)) return row;
  if (!canReadTable(role, table)) return null;
  if (table === 'events' && row.audience === 'finance') return null;
  const f = COST_FIELDS[table]; if (!f) return row;
  const r = { ...row }; for (const k of f) if (k in r) r[k] = 0; return r;
}
/* Closing figures include profit, so only cost roles receive them. */
export function redactSettings(role, settings) {
  if (seesCosts(role) || !settings?.periodLog) return settings;
  return { ...settings, periodLog: settings.periodLog.map(({ figures, ...x }) => x) };
}
