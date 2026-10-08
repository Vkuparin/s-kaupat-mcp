/**
 * Checkout: everything up to the order itself happens through these calls, so the caller app can show
 * it in its own screens. Card payment is the one hand-off: S-kaupat sends the user to its payment
 * provider's page (also for saved cards), which then returns to S-kaupat's own site.
 *
 * These are this project's own shapes; the adapters translate S-kaupat's (docs/s-kaupat-api.md
 * section 7, from the site's own checkout code).
 */

/** card: pay on the payment provider's page (Maksukortti). invoice: company invoice. on_delivery: pay when collecting. */
export type PaymentMethod = "card" | "invoice" | "on_delivery";

export interface SavedCard {
  cardId: string;
  /** The user's own name for the card when they gave one, otherwise S-kaupat's (e.g. "Visa"). */
  label: string | null;
  /** E.g. "**** **** **** 1234", as S-kaupat reports it. */
  maskedNumber: string | null;
  /** visa, mastercard, s_visa, s_business, american_express or unknown. */
  type: string;
  /** MM/YY as S-kaupat reports it. */
  expiryDate: string | null;
  /** expired cards cannot be used; expiring ones still work. */
  expiryStatus: "valid" | "expiring" | "expired" | "unknown";
  isDefault: boolean;
}

/** A packaging choice (Pakkausmateriaali). Every order has exactly one. */
export interface PackagingOption {
  /** Put this in the order as packagingId. */
  packagingId: string;
  type: "plastic_bag" | "cardboard_box" | "deposit_bag" | "standard" | "unknown";
  /** Euros S-kaupat expects this packaging to cost for an order (live: box 0,85 €, bags 3,00 €). */
  price: number | null;
  /** Euros per bag or box, when S-kaupat gives it (live: plastic bag 0,59 €); the store counts what it uses. */
  unitPrice: number | null;
}

/** Fees and products S-kaupat adds to an order for this time (e.g. the delivery fee). */
export interface MandatoryProduct {
  id: string;
  name: string | null;
  price: number | null;
  /** S-kaupat's own kind: DELIVERY_PRODUCT, SERVICE_FEE, PACKAGING_PRODUCT, ... */
  kind: string | null;
}

export interface CustomerProfile {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  /** b2c (consumer) or b2b (company). */
  customerType: "b2c" | "b2b" | null;
  /** Company customers only. */
  companyId: string | null;
}

export interface StoreCheckoutInfo {
  /** As S-kaupat lists them for the store, before customer-type rules. */
  paymentMethods: PaymentMethod[];
  /** Orders under limit cost amount more; both formatted by S-kaupat, e.g. "40,00 €". */
  smallOrderFee: { limit: string | null; limitAmount: number | null; amount: string | null } | null;
}

export interface SummaryRow {
  /** S-kaupat's own Finnish title, e.g. "Tuotteet yhteensä". */
  title: string;
  /** Formatted by S-kaupat, e.g. "23,45 €". */
  amount: string | null;
}

/** S-kaupat's own order summary, exactly as the site shows it at checkout. */
export interface OrderSummary {
  products: SummaryRow[];
  smallOrderFee: SummaryRow[];
  serviceFees: SummaryRow[];
  discounts: SummaryRow[];
  total: SummaryRow[];
  /** E.g. that weighed products are charged by their real weight. */
  disclaimer: string | null;
}

export interface OrderItemInput {
  /** EAN. */
  productId: string;
  /** Pieces, or kilograms for products sold by weight. */
  quantity: number;
  allowSubstitutes: boolean;
  /** "KPL" or "KG" when known. */
  unit: string | null;
  note?: string | null;
}

export interface OrderContact {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

export interface DeliveryAddress {
  street: string;
  /** Staircase and flat, e.g. "B 12". */
  extra: string | null;
  postalCode: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
}

export interface NewOrder {
  storeId: string;
  slotId: string;
  reservationId: string | null;
  items: OrderItemInput[];
  packagingId: string;
  contact: OrderContact;
  /** Home delivery only. */
  address: DeliveryAddress | null;
  payment: PaymentMethod;
  note: string | null;
  discountCode: string | null;
}

/** Order states as an app shows them. raw keeps S-kaupat's own value. */
export type OrderState = "received" | "being_picked" | "done" | "cancelled" | "unknown";
export type PaymentState =
  | "not_needed"
  | "awaiting_payment"
  | "paid"
  | "charged"
  | "payment_failed"
  | "payment_link"
  | "cancelled"
  | "unknown";

export interface OrderInfo {
  orderId: string;
  orderNumber: string | null;
  state: OrderState;
  payment: PaymentState;
  paymentMethod: PaymentMethod | null;
  raw: { orderStatus: string | null; paymentStatus: string | null; paymentMethod: string | null };
  deliveryDate: string | null;
  deliveryTime: string | null;
  storeId: string | null;
  isCancelable: boolean | null;
  isModifiable: boolean | null;
  summary: OrderSummary | null;
  /** S-kaupat's link for paying a failed charge, when there is one. */
  paymentLinkUrl: string | null;
  trackingUrl: string | null;
}

/** A just-created order. accessToken authorises later calls on it: keep it, never show or log it. */
export interface CreatedOrder extends OrderInfo {
  accessToken: string | null;
}

export interface Reservation {
  reservationId: string;
  expiresAt: string | null;
}

/** Whether S-kaupat accepts this cart for this time, per product. */
export interface OrderValidation {
  orderingPossible: boolean;
  items: { productId: string; status: "ok" | "unavailable" | "not_in_store" | "not_found" | "alcohol_not_allowed" | "not_for_robot" | "unknown"; label: string | null }[];
}

export interface CheckoutApi {
  getStoreCheckoutInfo(storeId: string): Promise<StoreCheckoutInfo>;
  getPackagingOptions(areaId: string): Promise<PackagingOption[]>;
  getMandatoryProducts(storeId: string, method: "pickup" | "home_delivery", slotId: string, reservationId: string | null): Promise<MandatoryProduct[]>;
  getCustomerProfile(accessToken: string): Promise<CustomerProfile>;
  getSavedCards(accessToken: string, storeId: string): Promise<SavedCard[]>;
  getOrderSummary(
    accessToken: string | null,
    input: { slotId: string; reservationId: string | null; items: { productId: string; price: number; quantity: number }[]; packagingId: string | null },
  ): Promise<OrderSummary>;
  validateOrder(storeId: string, slotId: string, date: string, items: OrderItemInput[], areaId: string | null): Promise<OrderValidation>;
  reserveSlot(accessToken: string, slotId: string): Promise<Reservation>;
  refreshReservation(accessToken: string, reservationId: string): Promise<Reservation>;
  releaseReservation(accessToken: string, reservationId: string): Promise<void>;
  createOrder(accessToken: string, order: NewOrder): Promise<CreatedOrder>;
  /** The payment provider's page for this order. cardId null = a new card. */
  createPayment(accessToken: string, orderId: string, cardId: string | null, saveCard: boolean): Promise<string>;
  /** After the provider's page returned OK: asks S-kaupat to authorise the payment. */
  authorizePayment(accessToken: string, orderId: string): Promise<boolean>;
  getOrder(accessToken: string, orderId: string, orderToken: string | null): Promise<OrderInfo | null>;
  cancelOrder(accessToken: string, orderId: string, orderToken: string | null): Promise<OrderInfo["state"]>;
}
