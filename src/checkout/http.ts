import { SKaupatError, toSKaupatError } from "../errors.js";
import { log } from "../log.js";
import { redactValues, type GraphQLBody } from "../client/http-client.js";
import type {
  CheckoutApi,
  CreatedOrder,
  CustomerProfile,
  MandatoryProduct,
  NewOrder,
  OrderHistoryEntry,
  OrderInfo,
  OrderItemInput,
  OrderState,
  OrderSummary,
  OrderValidation,
  PackagingOption,
  PastOrderItem,
  PaymentMethod,
  PaymentState,
  Reservation,
  SavedCard,
  StoreCheckoutInfo,
  SummaryRow,
} from "./types.js";

/** What this adapter needs from the HTTP client: one GraphQL call that never logs its variables. */
export interface GraphQLCaller {
  graphql(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    options?: { accessToken?: string | null; orderToken?: string | null; rawErrors?: boolean },
  ): Promise<GraphQLBody>;
}

/*
 * Query texts follow the site's own checkout operations (from its public JavaScript, 2026-10-08), trimmed
 * to the fields this server uses. docs/s-kaupat-api.md section 7 has the flow.
 */
const SUMMARY_FIELDS =
  "cartItemsTotal { title amount { formatted } } smallOrderFee { title amount { formatted } } " +
  "serviceFees { title amount { formatted } } discounts { title amount { formatted } } " +
  "total { title amount { formatted } } disclaimer";
const ORDER_FIELDS =
  "id orderNumber orderStatus paymentStatus paymentMethod deliveryDate deliveryTime storeId";

const STORE_CHECKOUT_QUERY = `query StoreCheckoutInfo($storeId: ID!) { store(id: $storeId) { id availablePaymentMethods
  smallOrderFee { limit { amount formatted } amount { formatted } } } }`;
const PACKAGING_QUERY = `query PackagingMaterials($deliveryAreaId: ID!) { deliveryArea(id: $deliveryAreaId) { areaId
  availablePackagingMaterials { ean materialType materialPrice materialPriceUnit } } }`;
const MANDATORY_QUERY = `query GetMandatoryProducts($id: ID!, $deliveryMethod: DeliveryMethod!, $deliverySlotId: String!, $reservationId: String) {
  store(id: $id) { id mandatoryProducts(deliveryMethod: $deliveryMethod, deliverySlotId: $deliverySlotId, reservationId: $reservationId) {
    ean id name price priceUnit productType } } }`;
const PROFILE_QUERY = "query CheckoutProfile { userProfile { firstName lastName email phoneNumber customerType company { identityCode } } }";
/** Fallback if S-kaupat renames a contact field: the name and customer type are enough to go on. */
const PROFILE_QUERY_MIN = "query CheckoutProfileName { userProfile { firstName lastName customerType } }";
const CARDS_QUERY = `query GetUserPaymentCards($storeId: ID) { userPaymentCards(storeId: $storeId) {
  cards { id maskedCardNumber name expiryDate type userGeneratedName expiryStatus } defaultPaymentCardId } }`;
const SUMMARY_QUERY = `query OrderSummary($input: OrderSummaryInput!) { orderSummary(input: $input) { ${SUMMARY_FIELDS} } }`;
const VALIDATE_QUERY = `query OrderCartValidation($items: [PartialCartItemInput!]!, $storeId: ID!, $deliveryDate: String, $slotId: ID, $areaId: ID) {
  validateCart(partialCartItems: $items, storeId: $storeId, deliveryDate: $deliveryDate, slotId: $slotId, areaId: $areaId) {
    isOrderingPossible
    cartValidationItems { ean labels { labelText } validationError { __typename
      ... on ProductAvailabilityError { labelText isOrderingPossible } } } } }`;
const RESERVE_MUTATION =
  "mutation CreateDeliverySlotReservation($deliverySlotId: ID!) { createDeliverySlotReservation(deliverySlotId: $deliverySlotId) { reservationId expiresAt } }";
const REFRESH_MUTATION =
  "mutation RefreshDeliverySlotReservation($reservationId: ID!) { refreshDeliverySlotReservation(reservationId: $reservationId) { reservationId expiresAt } }";
const RELEASE_MUTATION =
  "mutation ReleaseDeliverySlotReservation($reservationId: ID!) { releaseDeliverySlotReservation(reservationId: $reservationId) }";
const CREATE_ORDER_MUTATION = `mutation CreateOrder($order: OrderInput) { createOrder(order: $order) { ${ORDER_FIELDS} accessToken } }`;
const CREATE_PAYMENT_MUTATION = `mutation CreatePayment($orderId: ID!, $cardId: ID, $shouldSavePaymentCard: Boolean) {
  createPayment(orderId: $orderId, cardId: $cardId, shouldSavePaymentCard: $shouldSavePaymentCard) { redirectUrl } }`;
const AUTHORIZE_MUTATION = "mutation AuthorizePayment($orderId: ID!) { authorizePayment(orderId: $orderId) { orderId authorized } }";
const ORDER_QUERY = `query GetOrderById($id: ID!) { order(id: $id) { ${ORDER_FIELDS} isCancelable isModifiable trackingUrl
  paymentLink { url } summary { ${SUMMARY_FIELDS} } } }`;
const HISTORY_QUERY = `query GetOrderHistory($domain: Domain, $dataSources: [UserOrderDataSource!], $limit: Int) {
  userOrders(domain: $domain, dataSources: $dataSources, limit: $limit) { id createdAt storeName storeId deliveryDate
    deliveryMethod deliveryTime totalCost orderStatus orderNumber isModifiable isCancelable isFastTrack trackingUrl
    paymentMethod paymentStatus paymentLink { url } } }`;
const ORDER_ITEMS_QUERY = `query GetOrderCopyDataById($id: ID!) { order(id: $id) { id orderNumber
  cartItems { ean itemCount name price priceUnit additionalInfo replace product { id productType pricing { salesUnit } } } } }`;
const LOCKER_QUERY = "query GetOrderWithLockerById($id: ID!) { order(id: $id) { orderNumber locker { pin } } }";
const CANCEL_MUTATION = "mutation CancelOrder($id: ID!) { cancelOrder(id: $id) { id orderStatus } }";

const API_PAYMENT: Record<PaymentMethod, string> = { card: "CARD_PAYMENT", invoice: "INVOICE", on_delivery: "ON_DELIVERY" };

export class HttpCheckoutApi implements CheckoutApi {
  constructor(private readonly api: GraphQLCaller) {}

  async getStoreCheckoutInfo(storeId: string): Promise<StoreCheckoutInfo> {
    const data = await this.data("StoreCheckoutInfo", STORE_CHECKOUT_QUERY, { storeId });
    const store = obj(data.store);
    const fee = obj(store.smallOrderFee);
    const limit = obj(fee.limit);
    return {
      paymentMethods: arr(store.availablePaymentMethods).map(paymentMethod).filter((m): m is PaymentMethod => m !== null),
      smallOrderFee: store.smallOrderFee
        ? { limit: str(limit.formatted), limitAmount: num(limit.amount), amount: str(obj(fee.amount).formatted) }
        : null,
    };
  }

  async getPackagingOptions(areaId: string): Promise<PackagingOption[]> {
    const data = await this.data("PackagingMaterials", PACKAGING_QUERY, { deliveryAreaId: areaId });
    return arr(obj(data.deliveryArea).availablePackagingMaterials).map((m) => {
      const o = obj(m);
      return {
        packagingId: String(o.ean),
        type: materialType(str(o.materialType)),
        price: num(o.materialPrice),
        // Named like a unit, but live it holds the price per bag (2026-10-08: "0.59").
        unitPrice: num(o.materialPriceUnit),
      };
    });
  }

  async getMandatoryProducts(storeId: string, method: "pickup" | "home_delivery", slotId: string, reservationId: string | null): Promise<MandatoryProduct[]> {
    const data = await this.data("GetMandatoryProducts", MANDATORY_QUERY, {
      id: storeId,
      deliveryMethod: method === "pickup" ? "PICKUP" : "HOME_DELIVERY",
      deliverySlotId: slotId,
      reservationId,
    });
    return arr(obj(data.store).mandatoryProducts).map((p) => {
      const o = obj(p);
      return { id: String(o.ean ?? o.id), name: str(o.name), price: num(o.price), kind: str(o.productType) };
    });
  }

  async getCustomerProfile(accessToken: string): Promise<CustomerProfile> {
    let data: Record<string, unknown>;
    try {
      data = await this.data("CheckoutProfile", PROFILE_QUERY, {}, { accessToken });
    } catch (err) {
      if (toSKaupatError(err).code !== "upstream_error") throw err;
      log.warn("Full profile query failed; using the name only");
      data = await this.data("CheckoutProfileName", PROFILE_QUERY_MIN, {}, { accessToken });
    }
    const p = obj(data.userProfile);
    const type = str(p.customerType)?.toLowerCase();
    return {
      firstName: str(p.firstName),
      lastName: str(p.lastName),
      email: str(p.email),
      phone: str(p.phoneNumber),
      customerType: type === "b2b" || type === "b2c" ? type : null,
      companyId: str(obj(p.company).identityCode),
    };
  }

  async getSavedCards(accessToken: string, storeId: string): Promise<SavedCard[]> {
    const data = await this.data("GetUserPaymentCards", CARDS_QUERY, { storeId }, { accessToken });
    const cards = obj(data.userPaymentCards);
    const defaultId = str(cards.defaultPaymentCardId);
    return arr(cards.cards).map((c) => {
      const o = obj(c);
      const expiry = str(o.expiryStatus)?.toLowerCase();
      return {
        cardId: String(o.id),
        label: str(o.userGeneratedName) ?? str(o.name),
        maskedNumber: str(o.maskedCardNumber),
        type: str(o.type)?.toLowerCase() ?? "unknown",
        expiryDate: str(o.expiryDate),
        expiryStatus: expiry === "valid" || expiry === "expiring" || expiry === "expired" ? expiry : "unknown",
        isDefault: defaultId !== null && String(o.id) === defaultId,
      };
    });
  }

  async getOrderSummary(
    accessToken: string | null,
    input: { slotId: string; reservationId: string | null; items: { productId: string; price: number; quantity: number }[]; packagingId: string | null },
  ): Promise<OrderSummary> {
    const data = await this.data(
      "OrderSummary",
      SUMMARY_QUERY,
      {
        input: {
          deliverySlotId: input.slotId,
          reservationId: input.reservationId,
          cartItems: input.items.map((i) => ({ ean: i.productId, price: i.price, itemCount: i.quantity })),
          packagingMaterialEan: input.packagingId,
        },
      },
      { accessToken },
    );
    return mapSummary(data.orderSummary);
  }

  async validateOrder(storeId: string, slotId: string, date: string, items: OrderItemInput[], areaId: string | null): Promise<OrderValidation> {
    const data = await this.data("OrderCartValidation", VALIDATE_QUERY, {
      storeId,
      slotId,
      deliveryDate: date,
      areaId,
      items: items.map((i) => ({ ean: i.productId, itemCount: String(i.quantity) })),
    });
    const result = obj(data.validateCart);
    return {
      orderingPossible: result.isOrderingPossible !== false,
      items: arr(result.cartValidationItems).map((i) => {
        const o = obj(i);
        const error = o.validationError ? obj(o.validationError) : null;
        return {
          productId: String(o.ean),
          status: validationStatus(error ? str(error.__typename) : null),
          label: str(error?.labelText) ?? str(obj(arr(o.labels).find((l) => str(obj(l).labelText))).labelText),
        };
      }),
    };
  }

  async reserveSlot(accessToken: string, slotId: string): Promise<Reservation> {
    const body = await this.api.graphql("CreateDeliverySlotReservation", RESERVE_MUTATION, { deliverySlotId: slotId }, { accessToken, rawErrors: true });
    throwOrderError(body, "slot");
    return reservation(body.data?.createDeliverySlotReservation);
  }

  async refreshReservation(accessToken: string, reservationId: string): Promise<Reservation> {
    const body = await this.api.graphql("RefreshDeliverySlotReservation", REFRESH_MUTATION, { reservationId }, { accessToken, rawErrors: true });
    throwOrderError(body, "slot");
    return reservation(body.data?.refreshDeliverySlotReservation);
  }

  async releaseReservation(accessToken: string, reservationId: string): Promise<void> {
    await this.data("ReleaseDeliverySlotReservation", RELEASE_MUTATION, { reservationId }, { accessToken });
  }

  async createOrder(accessToken: string, order: NewOrder): Promise<CreatedOrder> {
    let body: GraphQLBody;
    try {
      body = await this.api.graphql("CreateOrder", CREATE_ORDER_MUTATION, { order: orderInput(order) }, { accessToken, rawErrors: true });
    } catch (err) {
      const e = toSKaupatError(err);
      // Refused before it reached the order service: nothing was created.
      if (["blocked", "session_expired", "login_in_progress", "browser_unavailable", "browser_busy"].includes(e.code)) throw e;
      // HTTP 400: S-kaupat rejected the request itself (its API changed), so no order was made.
      if (e.details?.httpStatus === 400) throw e;
      // Anything else (a timeout, a lost connection, a server error) may have happened after the order was made.
      throw new SKaupatError("order_uncertain", `createOrder did not answer clearly: ${e.message}`);
    }
    throwOrderError(body, "order");
    const created = obj(body.data?.createOrder);
    if (!created.id) throw new SKaupatError("order_uncertain", "createOrder returned no order id.");
    return { ...mapOrder(created), accessToken: str(created.accessToken) };
  }

  async createPayment(accessToken: string, orderId: string, cardId: string | null, saveCard: boolean): Promise<string> {
    const body = await this.api.graphql(
      "CreatePayment",
      CREATE_PAYMENT_MUTATION,
      // customWebstoreRedirectUrl is left out, as the site does in production: S-kaupat picks the return page.
      { orderId, cardId, shouldSavePaymentCard: cardId ? false : saveCard },
      { accessToken, rawErrors: true },
    );
    throwOrderError(body, "payment");
    const url = str(obj(body.data?.createPayment).redirectUrl);
    if (!url) throw new SKaupatError("payment_failed", "createPayment returned no payment page.");
    return url;
  }

  async authorizePayment(accessToken: string, orderId: string): Promise<boolean> {
    const body = await this.api.graphql("AuthorizePayment", AUTHORIZE_MUTATION, { orderId }, { accessToken, rawErrors: true });
    throwOrderError(body, "payment");
    const result = obj(body.data?.authorizePayment);
    return result.authorized === true && String(result.orderId) === orderId;
  }

  async getOrder(accessToken: string, orderId: string, orderToken: string | null): Promise<OrderInfo | null> {
    const body = await this.api.graphql("GetOrderById", ORDER_QUERY, { id: orderId }, { accessToken, orderToken, rawErrors: true });
    const order = body.data?.order;
    if (!order) {
      if (body.errors?.length && !body.errors.some((e) => /not ?found/i.test(e.message ?? ""))) throwOrderError(body, "order");
      return null;
    }
    return mapOrder(obj(order));
  }

  async cancelOrder(accessToken: string, orderId: string, orderToken: string | null): Promise<OrderState> {
    const body = await this.api.graphql("CancelOrder", CANCEL_MUTATION, { id: orderId }, { accessToken, orderToken, rawErrors: true });
    throwOrderError(body, "order");
    return orderState(str(obj(body.data?.cancelOrder).orderStatus));
  }

  async getOrderHistory(accessToken: string, limit: number): Promise<OrderHistoryEntry[]> {
    // The site's own variables: S-kaupat orders only (not Foodie).
    const data = await this.data("GetOrderHistory", HISTORY_QUERY, { domain: "S_KAUPAT", dataSources: ["S_KAUPAT"], limit }, { accessToken });
    const list = Array.isArray(data.userOrders) ? data.userOrders : [];
    return list.map((raw) => mapHistoryEntry(obj(raw)));
  }

  async getOrderItems(accessToken: string, orderId: string, orderToken: string | null): Promise<PastOrderItem[] | null> {
    const body = await this.api.graphql("GetOrderCopyDataById", ORDER_ITEMS_QUERY, { id: orderId }, { accessToken, orderToken, rawErrors: true });
    const order = body.data?.order;
    if (!order) {
      if (body.errors?.length && !body.errors.some((e) => /not ?found/i.test(e.message ?? ""))) throwOrderError(body, "order");
      return null;
    }
    const rows = obj(order).cartItems;
    return (Array.isArray(rows) ? rows : []).flatMap((raw) => {
      const r = obj(raw);
      const product = obj(r.product);
      const ean = str(r.ean);
      const quantity = num(r.itemCount);
      // Packaging, bags and fees are rows too; only products can be ordered again.
      const type = str(product.productType)?.toUpperCase();
      if (!ean || quantity === null || quantity <= 0 || (type && type !== "PRODUCT")) return [];
      const unit = (str(obj(product.pricing).salesUnit) ?? str(r.priceUnit))?.toUpperCase() ?? null;
      return [
        {
          productId: ean,
          name: str(r.name)?.trim() || null,
          quantity,
          unit,
          price: num(r.price),
          allowSubstitutes: r.replace !== false,
          note: str(r.additionalInfo)?.trim() || null,
        },
      ];
    });
  }

  async getLockerPin(accessToken: string, orderId: string, orderToken: string | null): Promise<string | null> {
    const body = await this.api.graphql("GetOrderWithLockerById", LOCKER_QUERY, { id: orderId }, { accessToken, orderToken, rawErrors: true });
    return str(obj(obj(body.data?.order).locker).pin);
  }

  private async data(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    options: { accessToken?: string | null } = {},
  ): Promise<Record<string, unknown>> {
    const body = await this.api.graphql(operationName, query, variables, options);
    return body.data ?? {};
  }
}

function orderInput(o: NewOrder): Record<string, unknown> {
  return {
    storeId: o.storeId,
    deliverySlotId: o.slotId,
    reservationId: o.reservationId,
    paymentMethod: API_PAYMENT[o.payment],
    discountCode: o.discountCode,
    additionalInfo: o.note,
    cartItems: [
      ...o.items.map((i) => ({
        ean: i.productId,
        // OrderInput's itemCount is a string, as in validateCart.
        itemCount: String(i.quantity),
        replace: i.allowSubstitutes,
        additionalInfo: i.note ?? null,
        basicQuantityUnit: i.unit,
      })),
      // Every order carries exactly one packaging product; the store counts the bags.
      { ean: o.packagingId, itemCount: "1", replace: false, additionalInfo: null, basicQuantityUnit: null },
    ],
    customer: {
      firstName: o.contact.firstName,
      lastName: o.contact.lastName,
      phone: o.contact.phone,
      email: o.contact.email,
      companyName: null,
      companyIdentityCode: null,
      invoiceNumber: "",
      // Pickup orders have no address; the site sends empty strings.
      addressLine1: o.address?.street ?? "",
      addressLine2: o.address?.extra ?? null,
      postalCode: o.address?.postalCode ?? "",
      city: o.address?.city ?? "",
      addressCoordinates:
        o.address && o.address.latitude !== null && o.address.longitude !== null
          ? { latitude: o.address.latitude, longitude: o.address.longitude }
          : null,
    },
  };
}

/**
 * S-kaupat reports order and payment problems as GraphQL errors with extensions.errorType (seen in the
 * site's own error handling). Codes the app can act on; anything else is upstream_error.
 */
function throwOrderError(body: GraphQLBody, stage: "slot" | "order" | "payment"): void {
  const errors = body.errors ?? [];
  if (errors.length === 0) return;
  const types = errors.map((e) => String(e.extensions?.errorType ?? e.extensions?.code ?? ""));
  const has = (t: string) => types.includes(t);
  if (types.some((t) => ["UNAUTHENTICATED", "UNAUTHORIZED", "FORBIDDEN"].includes(t))) {
    throw new SKaupatError("session_expired", "S-kaupat did not accept the login for a checkout call.");
  }
  if (has("ReservationNotFoundError")) throw new SKaupatError("reservation_expired", "The time reservation was not found.");
  if (has("SlotClosedError") || has("SlotFullError")) {
    throw new SKaupatError("slot_unavailable", `S-kaupat says the time is ${has("SlotFullError") ? "full" : "closed"}.`);
  }
  if (has("UnpaidPaymentLinkError") || has("UnpaidDebtContactCustomerServiceError")) {
    const unpaid = arr(errors.find((e) => e.extensions?.unpaidOrders)?.extensions?.unpaidOrders).map((u) => {
      const o = obj(u);
      return {
        orderNumber: str(o.orderNumber),
        unpaidEuros: num(o.unpaidAmountInCents) !== null ? num(o.unpaidAmountInCents)! / 100 : null,
        paymentUrl: str(o.paymentLinkSentToCustomer),
      };
    });
    throw new SKaupatError("unpaid_orders", "S-kaupat refuses new orders while an earlier one is unpaid.", {
      unpaidOrders: unpaid,
      contactCustomerService: has("UnpaidDebtContactCustomerServiceError"),
    });
  }
  // Errors next to a usable answer (a payment page, an authorisation) are warnings, not failures.
  if (body.data && Object.values(body.data).some((v) => v !== null)) return;
  const refusal = errors.map((e) => str(e.extensions?.refusalReason)).find(Boolean) ?? null;
  const typeList = types.filter(Boolean).join(", ") || "no type";
  if (stage === "payment" || has("PaymentCardNotFoundError") || has("PaymentCardRegistrationError")) {
    throw new SKaupatError("payment_failed", `Payment step refused (${typeList}).`, {
      reason: refusal ? refusal.toLowerCase() : has("PaymentCardNotFoundError") ? "card_not_found" : null,
    });
  }
  if (has("PossiblePaymentInputError") || refusal) {
    // Refused while creating the order: there is nothing to pay; the details need changing.
    throw new SKaupatError("order_not_ready", `S-kaupat refused the order (${typeList}).`, { reason: refusal ? refusal.toLowerCase() : null });
  }
  // Only the error type names reach the log; S-kaupat's message may quote the order's own values.
  log.warn("Checkout call failed", { stage, types: types.filter(Boolean) });
  // A request S-kaupat's schema refused never reached the order service.
  const rejectedRequest = errors.some(
    (e) =>
      /got invalid value|is not defined by type|Cannot query field|Unknown argument|Syntax Error/i.test(e.message ?? "") ||
      /GRAPHQL_(VALIDATION|PARSE)_FAILED|BAD_USER_INPUT/.test(String(e.extensions?.code ?? "")),
  );
  if (stage === "order" && !rejectedRequest) {
    // An unrecognised failure while creating the order may have come after the order was made.
    throw new SKaupatError("order_uncertain", `createOrder failed: ${redactValues(errors[0]?.message ?? "unknown error").slice(0, 200)}`);
  }
  throw new SKaupatError("upstream_error", redactValues(errors[0]?.message ?? "S-kaupat returned an error.").slice(0, 200));
}

function reservation(raw: unknown): Reservation {
  const o = obj(raw);
  if (!o.reservationId) throw new SKaupatError("upstream_error", "S-kaupat returned no reservation.");
  return { reservationId: String(o.reservationId), expiresAt: str(o.expiresAt) };
}

export function mapHistoryEntry(o: Record<string, unknown>): OrderHistoryEntry {
  const { summary: _summary, ...info } = mapOrder(o);
  const method = str(o.deliveryMethod)?.toUpperCase() ?? "";
  const total = typeof o.totalCost === "number" ? o.totalCost : num(o.totalCost);
  return {
    ...info,
    createdAt: str(o.createdAt),
    storeName: str(o.storeName)?.trim() || null,
    deliveryMethod: o.isFastTrack === true ? "express" : method === "PICKUP" ? "pickup" : method === "HOME_DELIVERY" ? "home_delivery" : null,
    total: total === null ? null : Math.round(total * 100) / 100,
  };
}

export function mapOrder(o: Record<string, unknown>): OrderInfo {
  const rawPayment = str(o.paymentMethod);
  const method = rawPayment ? paymentMethod(rawPayment) : null;
  const rawStatus = str(o.orderStatus);
  const rawPaymentStatus = str(o.paymentStatus);
  return {
    orderId: String(o.id),
    orderNumber: o.orderNumber === undefined || o.orderNumber === null ? null : String(o.orderNumber),
    state: orderState(rawStatus),
    payment: paymentState(method, rawPaymentStatus, rawStatus),
    paymentMethod: method,
    raw: { orderStatus: rawStatus, paymentStatus: rawPaymentStatus, paymentMethod: rawPayment },
    deliveryDate: str(o.deliveryDate),
    deliveryTime: str(o.deliveryTime),
    storeId: str(o.storeId),
    isCancelable: typeof o.isCancelable === "boolean" ? o.isCancelable : null,
    isModifiable: typeof o.isModifiable === "boolean" ? o.isModifiable : null,
    summary: o.summary ? mapSummary(o.summary) : null,
    paymentLinkUrl: str(obj(o.paymentLink).url),
    trackingUrl: str(o.trackingUrl),
  };
}

export function orderState(raw: string | null): OrderState {
  switch (raw) {
    case "NEW":
    case "OPEN":
    case "MODIFIED":
      return "received";
    case "IN_PROGRESS":
      return "being_picked";
    case "DONE":
      return "done";
    case "CANCELLED":
      return "cancelled";
    default:
      return "unknown";
  }
}

/** The site's own reading: a card order is waiting for payment while its status is missing, PENDING, UNAVAILABLE or failed. */
export function paymentState(method: PaymentMethod | null, raw: string | null, orderStatus: string | null): PaymentState {
  if (orderStatus === "CANCELLED" || raw === "CANCELED") return "cancelled";
  switch (raw) {
    case "CARD_AUTHORIZED":
      return "paid";
    case "CAPTURE_COMPLETED":
      return "charged";
    case "CARD_AUTHORIZATION_FAILED":
    case "CAPTURE_FAILED":
      return "payment_failed";
    case "PAYMENT_LINK_CREATED":
    case "PAYMENT_LINK_EXPIRED":
    case "MOVED_TO_DEBT_COLLECTION":
      return "payment_link";
  }
  if (method === "card") return raw === null || raw === "PENDING" || raw === "UNAVAILABLE" ? "awaiting_payment" : "unknown";
  if (method === "invoice" || method === "on_delivery") return "not_needed";
  return "unknown";
}

function paymentMethod(raw: unknown): PaymentMethod | null {
  switch (raw) {
    case "CARD_PAYMENT":
      return "card";
    case "INVOICE":
      return "invoice";
    case "ON_DELIVERY":
      return "on_delivery";
    default:
      return null;
  }
}

function materialType(raw: string | null): PackagingOption["type"] {
  switch (raw) {
    case "PLASTIC_BAG":
      return "plastic_bag";
    case "CARDBOARD_BOX":
      return "cardboard_box";
    case "DEPOSIT_BAG":
      return "deposit_bag";
    case "STANDARD_PACKAGING":
      return "standard";
    default:
      return "unknown";
  }
}

function validationStatus(typename: string | null): OrderValidation["items"][number]["status"] {
  switch (typename) {
    case null:
      return "ok";
    case "ProductAvailabilityError":
      return "unavailable";
    case "ProductNotInAssortmentError":
      return "not_in_store";
    case "ProductNotFoundError":
      return "not_found";
    case "AlcoholSellingError":
      return "alcohol_not_allowed";
    case "ProductDoesNotFitRobotError":
      return "not_for_robot";
    default:
      return "unknown";
  }
}

function mapSummary(raw: unknown): OrderSummary {
  const s = obj(raw);
  const rows = (v: unknown): SummaryRow[] =>
    (Array.isArray(v) ? v : v ? [v] : []).map((r) => ({ title: str(obj(r).title) ?? "", amount: str(obj(obj(r).amount).formatted) }));
  return {
    products: rows(s.cartItemsTotal),
    smallOrderFee: rows(s.smallOrderFee),
    serviceFees: rows(s.serviceFees),
    discounts: rows(s.discounts),
    total: rows(s.total),
    disclaimer: str(s.disclaimer),
  };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : null;
}
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
}
