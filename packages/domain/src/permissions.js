/* Who may run each command, and who may open each screen. The server enforces
   COMMAND_ROLES on every request. The web app reads the same table to hide what
   a user can't do, so the two can never disagree. */
export const ROLES = ['owner', 'operations', 'warehouse', 'finance', 'driver'];
const OPS = 'operations', WH = 'warehouse', FIN = 'finance', DRV = 'driver';
export const COMMAND_ROLES = {
  createOrder: [OPS], createOrderWithCustomer: [OPS], importOrders: [OPS], addOrderNote: [OPS, WH, FIN], confirmOrder: [OPS], advanceOrder: [OPS, WH], cancelOrder: [OPS],
  attribute: [FIN],
  assign: [OPS], reassign: [OPS], driverHandover: [OPS], pickup: [OPS, WH], setDeliveryStatus: [OPS, DRV], deliver: [OPS, DRV], collect: [OPS, FIN, DRV], prepay: [OPS, FIN], startReturn: [OPS, DRV], receiveAtWarehouse: [OPS, WH],
  recordHandover: [FIN], addDriverExpense: [OPS, FIN, DRV], decideDriverExpense: [FIN], resolveDiscrepancy: [FIN], recordSettlement: [FIN], refund: [FIN],
  openCase: [OPS], acceptReturn: [OPS, WH], rejectCase: [OPS, WH], createReplacement: [OPS], closeCase: [OPS, FIN],
  adjustStock: [OPS, WH], createProduction: [OPS, WH], startProduction: [OPS, WH], completeProduction: [OPS, WH], cancelProduction: [OPS, WH], saveSku: [OPS], receiveMaterial: [OPS, WH],
  saveCustomer: [OPS], setCustomerTags: [OPS], logContact: [OPS, FIN],
  saveCampaign: [FIN], addSpend: [FIN], addExpense: [FIN], removeExpense: [FIN],
  saveDriver: [OPS], setAvailability: [OPS], saveCourier: [], saveSettings: [], setRoadmap: [],
};
/* The owner may run everything in the table. Anything not in the table can't be called at all. */
export const canRun = (role, command) => Object.hasOwn(COMMAND_ROLES, command) && (role === 'owner' || COMMAND_ROLES[command].includes(role));
/* Commands a driver may run, and how to find the driver they must belong to. */
export const DRIVER_SCOPE = { setDeliveryStatus: 'delivery', deliver: 'delivery', collect: 'delivery', startReturn: 'delivery', addDriverExpense: 'driverField' };
export const ROLE_SCREENS = {
  owner: ['overview', 'orders', 'order360', 'crm', 'inventory', 'shipping', 'driver', 'finance', 'campaigns', 'settings', 'roadmap'],
  operations: ['overview', 'orders', 'order360', 'crm', 'inventory', 'shipping', 'driver', 'campaigns'],
  warehouse: ['orders', 'order360', 'inventory', 'shipping', 'driver'],
  finance: ['overview', 'orders', 'order360', 'crm', 'driver', 'shipping', 'finance', 'campaigns'],
  driver: ['driver'],
};
