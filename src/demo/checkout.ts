import { randomUUID } from "node:crypto";
import { SKaupatError } from "../errors.js";
import { orderState, paymentState } from "../checkout/http.js";
import type {
  CheckoutApi,
  CreatedOrder,
  CustomerProfile,
  MandatoryProduct,
  NewOrder,
  OrderHistoryEntry,
  OrderInfo,
  OrderItemInput,
  OrderSummary,
  OrderValidation,
  PackagingOption,
  PastOrderItem,
  Reservation,
  SavedCard,
  StoreCheckoutInfo,
} from "../checkout/types.js";

/**
 * Checkout for demo mode and tests: a pretend account with one saved card, orders kept in memory.
 * Nothing leaves the process. The "payment page" is a placeholder URL; confirm_payment marks it paid.
 */
export class DemoCheckout implements CheckoutApi {
  private readonly orders = new Map<string, { order: NewOrder; status: string; paymentStatus: string | null; number: string; token: string; createdAt: string }>();
  private readonly reservations = new Set<string>();
  private nextNumber = 100_001;
  /** Recorded calls, for tests. */
  readonly calls: string[] = [];

  async getStoreCheckoutInfo(): Promise<StoreCheckoutInfo> {
    return { paymentMethods: ["card", "on_delivery", "invoice"], smallOrderFee: { limit: "40,00 €", limitAmount: 40, amount: "5,90 €" } };
  }

  async getPackagingOptions(): Promise<PackagingOption[]> {
    return [
      { packagingId: "2000000000001", type: "deposit_bag", price: 0, unitPrice: null },
      { packagingId: "2000000000002", type: "plastic_bag", price: 1.95, unitPrice: 0.39 },
      { packagingId: "2000000000003", type: "cardboard_box", price: 0.85, unitPrice: null },
    ];
  }

  async getMandatoryProducts(): Promise<MandatoryProduct[]> {
    return [{ id: "2000000000010", name: "Keräilymaksu", price: 3.9, kind: "SERVICE_FEE" }];
  }

  async getCustomerProfile(): Promise<CustomerProfile> {
    return { firstName: "Demo", lastName: "Käyttäjä", email: "demo@example.com", phone: "+358401234567", customerType: "b2c", companyId: null };
  }

  async getSavedCards(): Promise<SavedCard[]> {
    return [
      {
        cardId: "demo-card-1",
        label: "Oma Visa",
        maskedNumber: "**** **** **** 1234",
        type: "visa",
        expiryDate: "12/29",
        expiryStatus: "valid",
        isDefault: true,
      },
    ];
  }

  async getOrderSummary(
    _token: string | null,
    input: { slotId: string; items: { productId: string; price: number; quantity: number }[]; packagingId: string | null },
  ): Promise<OrderSummary> {
    const products = input.items.reduce((s, i) => s + i.price * i.quantity, 0);
    const small = products < 40 ? 5.9 : 0;
    const fee = 3.9;
    return {
      products: [{ title: "Tuotteet yhteensä", amount: euros(products) }],
      smallOrderFee: small ? [{ title: "Pientilauslisä", amount: euros(small) }] : [],
      serviceFees: [{ title: "Keräilymaksu", amount: euros(fee) }],
      discounts: [],
      total: [{ title: "Yhteensä", amount: euros(products + small + fee) }],
      disclaimer: "Punnittavien tuotteiden hinta voi muuttua.",
    };
  }

  async validateOrder(_store: string, _slot: string, _date: string, items: OrderItemInput[]): Promise<OrderValidation> {
    return { orderingPossible: true, items: items.map((i) => ({ productId: i.productId, status: "ok" as const, label: null })) };
  }

  async reserveSlot(_token: string, slotId: string): Promise<Reservation> {
    this.calls.push(`reserve:${slotId}`);
    const id = `demo-res-${randomUUID()}`;
    this.reservations.add(id);
    return { reservationId: id, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
  }

  async refreshReservation(_token: string, reservationId: string): Promise<Reservation> {
    if (!this.reservations.has(reservationId)) throw new SKaupatError("reservation_expired", "Demo reservation not found.");
    return { reservationId, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
  }

  async releaseReservation(_token: string, reservationId: string): Promise<void> {
    this.calls.push("release");
    this.reservations.delete(reservationId);
  }

  async createOrder(_token: string, order: NewOrder): Promise<CreatedOrder> {
    this.calls.push(`order:${order.payment}`);
    if (order.reservationId) this.reservations.delete(order.reservationId);
    const id = randomUUID();
    const entry = {
      order,
      status: "NEW",
      paymentStatus: order.payment === "card" ? "PENDING" : null,
      number: String(this.nextNumber++),
      token: `demo-token-${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    this.orders.set(id, entry);
    return { ...this.info(id)!, accessToken: entry.token };
  }

  async createPayment(_token: string, orderId: string): Promise<string> {
    this.calls.push("payment");
    if (!this.orders.has(orderId)) throw new SKaupatError("order_not_found", "Demo order not found.");
    return `https://www.s-kaupat.fi/demo-maksu/${orderId}`;
  }

  async authorizePayment(_token: string, orderId: string): Promise<boolean> {
    const entry = this.orders.get(orderId);
    if (!entry) return false;
    entry.paymentStatus = "CARD_AUTHORIZED";
    return true;
  }

  async getOrder(_token: string, orderId: string): Promise<OrderInfo | null> {
    return this.info(orderId);
  }

  async cancelOrder(_token: string, orderId: string, orderToken: string | null): Promise<OrderInfo["state"]> {
    const entry = this.orders.get(orderId);
    if (!entry) throw new SKaupatError("order_not_found", "Demo order not found.");
    if (orderToken !== entry.token) throw new SKaupatError("upstream_error", "Demo order token does not match.");
    this.calls.push("cancel");
    entry.status = "CANCELLED";
    return "cancelled";
  }

  async getOrderHistory(_token: string, limit: number): Promise<OrderHistoryEntry[]> {
    return [...this.orders.keys()]
      .reverse()
      .slice(0, limit)
      .map((id) => {
        const { summary: _summary, ...info } = this.info(id)!;
        const entry = this.orders.get(id)!;
        return { ...info, createdAt: entry.createdAt, storeName: null, deliveryMethod: null, total: null };
      });
  }

  async getOrderItems(_token: string, orderId: string): Promise<PastOrderItem[] | null> {
    const entry = this.orders.get(orderId);
    if (!entry) return null;
    return entry.order.items.map((i) => ({
      productId: i.productId,
      name: null,
      quantity: i.quantity,
      unit: i.unit,
      price: null,
      allowSubstitutes: i.allowSubstitutes,
      note: i.note ?? null,
    }));
  }

  async getLockerPin(_token: string, orderId: string): Promise<string | null> {
    const entry = this.orders.get(orderId);
    // Demo lockers are the "Noutolokero" areas.
    return entry && entry.order.slotId.startsWith("demo-locker-") && entry.status !== "CANCELLED" ? "4711" : null;
  }

  private info(orderId: string): OrderInfo | null {
    const entry = this.orders.get(orderId);
    if (!entry) return null;
    const method = entry.order.payment;
    const rawMethod = method === "card" ? "CARD_PAYMENT" : method === "invoice" ? "INVOICE" : "ON_DELIVERY";
    return {
      orderId,
      orderNumber: entry.number,
      state: orderState(entry.status),
      payment: paymentState(method, entry.paymentStatus, entry.status),
      paymentMethod: method,
      raw: { orderStatus: entry.status, paymentStatus: entry.paymentStatus, paymentMethod: rawMethod },
      deliveryDate: null,
      deliveryTime: null,
      storeId: entry.order.storeId,
      isCancelable: entry.status !== "CANCELLED",
      isModifiable: entry.status !== "CANCELLED",
      summary: null,
      paymentLinkUrl: null,
      trackingUrl: null,
    };
  }
}

function euros(n: number): string {
  return `${n.toFixed(2).replace(".", ",")} €`;
}
