import { createHash, randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { SKaupatAuth } from "../auth/types.js";
import type { SKaupatClient } from "../client/types.js";
import { SKaupatError, toSKaupatError } from "../errors.js";
import type { ShoppingListApi } from "../lists/types.js";
import type { WithToken } from "../lists/service.js";
import { log } from "../log.js";
import { handoverOf } from "../delivery/format.js";
import type { SavedDelivery } from "../delivery/types.js";
import type { StoreSelection } from "../selection.js";
import type {
  CheckoutApi,
  CustomerProfile,
  DeliveryAddress,
  OrderContact,
  OrderInfo,
  OrderItemInput,
  OrderSummary,
  PackagingOption,
  PaymentMethod,
  SavedCard,
} from "./types.js";
import type { OrderStore } from "./order-store.js";

/** Where S-kaupat's payment provider sends the user back to (the site's own page, which then authorises the payment). */
export const PAYMENT_RETURN_PREFIX = "https://www.s-kaupat.fi/payment/auth/";
/** How long a review stays valid for place_order. Times and prices move; the user confirms what they just saw. */
const REVIEW_VALID_MS = 15 * 60_000;

export interface CheckoutContext {
  client: SKaupatClient;
  auth: SKaupatAuth;
  checkout: CheckoutApi;
  orders: OrderStore;
  selection: StoreSelection;
  lists?: ShoppingListApi;
  withToken: WithToken;
  resolveStoreId(id: string | undefined): string;
  /** The chosen time when it is for this store and still ahead. */
  currentDelivery(storeId: string): SavedDelivery | null;
  deliveryView(d: SavedDelivery): object;
  storeName(storeId: string): string | null;
  /** Opens a page in the server's own visible browser window; undefined without one (demo, other transports). */
  openWindow?: (url: string) => Promise<void>;
  /** false turns place_order off (the caller app's choice). */
  orderingEnabled: boolean;
  now(): Date;
  run(tool: string, fn: () => Promise<object>): Promise<CallToolResult>;
}

const itemSchema = z.object({
  productId: z.string().min(1).describe("Product ID (EAN) from search_products."),
  quantity: z.number().positive().max(99).default(1).describe("Pieces, or kilograms for products sold by weight."),
  allowSubstitutes: z.boolean().default(true).describe("Whether the store may pick a similar product if this one is out of stock."),
  note: z.string().max(200).optional().describe("A note to the picker about this product, e.g. 'kypsiä'."),
});

const draftShape = {
  listId: z.string().min(1).optional().describe("Order the products on this shopping list (with their quantities)."),
  items: z.array(itemSchema).min(1).max(100).optional().describe("Or order these products. Give listId or items."),
  packagingId: z
    .string()
    .min(1)
    .optional()
    .describe("packagingId from get_checkout_options. Leave out for S-kaupat's usual choice (the first that is not a deposit bag)."),
  payment: z
    .object({
      method: z.enum(["card", "invoice", "on_delivery"]),
      cardId: z.string().min(1).optional().describe("A saved card (get_checkout_options savedCards). Leave out to pay with a new card."),
      saveCard: z.boolean().default(false).describe("Save the new card on the S-kaupat account for next time."),
    })
    .describe("How the user pays: one of get_checkout_options paymentMethods."),
  contact: z
    .object({
      firstName: z.string().trim().min(1).max(60),
      lastName: z.string().trim().min(1).max(60),
      phone: z.string().trim().min(5).max(20),
      email: z.string().trim().email().max(120),
    })
    .partial()
    .optional()
    .describe("Contact details for the order. Missing fields come from the S-kaupat account (get_checkout_options contact)."),
  address: z
    .object({
      street: z.string().trim().min(1).max(100).describe("Street and house number, from find_address."),
      extra: z.string().trim().max(40).optional().describe("Staircase and flat, e.g. 'B 12'."),
      postalCode: z.string().regex(/^\d{5}$/),
      city: z.string().trim().min(1).max(60),
      latitude: z.number().min(59).max(71).optional(),
      longitude: z.number().min(19).max(32).optional(),
    })
    .optional()
    .describe("Home delivery only: where to deliver. The user's home address: never log it."),
  note: z.string().max(500).optional().describe("A note to the store about the whole order, e.g. a door code."),
  discountCode: z.string().max(40).optional(),
  storeId: z.string().min(1).optional().describe("Leave out to use the chosen store."),
};
type DraftInput = z.infer<z.ZodObject<typeof draftShape>>;

interface Draft {
  storeId: string;
  delivery: SavedDelivery;
  items: (OrderItemInput & { name: string | null; price: number | null })[];
  packaging: PackagingOption | null;
  packagingOptions: PackagingOption[];
  payment: { method: PaymentMethod; cardId: string | null; saveCard: boolean };
  contact: Partial<OrderContact>;
  address: DeliveryAddress | null;
  note: string | null;
  discountCode: string | null;
}

export function registerCheckoutTools(server: McpServer, ctx: CheckoutContext): void {
  /** Reviews awaiting confirmation: code -> fingerprint of what the user saw. */
  const reviews = new Map<string, { fingerprint: string; until: number }>();
  const secret = randomBytes(16).toString("hex");

  const requireDelivery = (store: string): SavedDelivery => {
    const d = ctx.currentDelivery(store);
    if (!d) {
      throw new SKaupatError("order_not_ready", "Choose a pickup or delivery time first (select_delivery).", { missing: ["delivery"] });
    }
    if (!handoverOf(d.area)) {
      // S-kaupat did not say whether this express option is collected or delivered (or an older version saved it).
      throw new SKaupatError("unsupported", "This delivery option can't be ordered in the app. Choose the time again, or finish on the site (open_site).");
    }
    return d;
  };

  /** Reads everything an order needs; nothing is written anywhere. */
  const buildDraft = async (input: DraftInput): Promise<Draft> => {
    if (!input.listId === !input.items) throw new SKaupatError("invalid_argument", "Give either listId or items.");
    const storeId = ctx.resolveStoreId(input.storeId);
    const delivery = requireDelivery(storeId);
    let rows: { productId: string; quantity: number; allowSubstitutes: boolean; note: string | null }[];
    if (input.listId) {
      if (!ctx.lists) throw new SKaupatError("unsupported", "Shopping lists are not available in this server.");
      const list = await ctx.withToken((t) => ctx.lists!.getList(t, input.listId!, storeId));
      if (!list) throw new SKaupatError("list_not_found", `Shopping list ${input.listId} was not found.`, { listId: input.listId });
      rows = list.items.map((i) => ({ productId: i.productId, quantity: i.quantity, allowSubstitutes: i.allowSubstitutes, note: null }));
    } else {
      rows = input.items!.map((i) => ({ productId: i.productId, quantity: i.quantity, allowSubstitutes: i.allowSubstitutes, note: i.note ?? null }));
    }
    if (rows.length === 0) throw new SKaupatError("order_not_ready", "The order has no products.", { missing: ["items"] });
    const [products, packagingOptions] = await Promise.all([
      ctx.client.getListableProducts(storeId, rows.map((r) => r.productId)),
      ctx.checkout.getPackagingOptions(delivery.area.areaId),
    ]);
    const items = rows.map((r) => {
      const p = products.get(r.productId)?.product;
      return { ...r, name: p?.name ?? null, price: p?.price ?? null, unit: p?.quantityUnit ?? null };
    });
    const packaging = input.packagingId
      ? (packagingOptions.find((p) => p.packagingId === input.packagingId) ?? null)
      : defaultPackaging(packagingOptions);
    if (input.packagingId && !packaging) {
      throw new SKaupatError("invalid_argument", `Packaging ${input.packagingId} is not offered for this time.`);
    }
    return {
      storeId,
      delivery,
      items,
      packaging,
      packagingOptions,
      payment: { method: input.payment.method, cardId: input.payment.cardId ?? null, saveCard: input.payment.saveCard },
      contact: input.contact ?? {},
      address: input.address
        ? {
            street: input.address.street,
            extra: input.address.extra ?? null,
            postalCode: input.address.postalCode,
            city: input.address.city,
            latitude: input.address.latitude ?? null,
            longitude: input.address.longitude ?? null,
          }
        : null,
      note: input.note ?? null,
      discountCode: input.discountCode ?? null,
    };
  };

  /** Fills contact details from the account and lists what is still missing or not allowed. */
  const complete = (draft: Draft, profile: CustomerProfile | null, methods: PaymentMethod[], cards: SavedCard[]) => {
    const contact: Partial<OrderContact> = {
      firstName: draft.contact.firstName ?? profile?.firstName ?? undefined,
      lastName: draft.contact.lastName ?? profile?.lastName ?? undefined,
      phone: draft.contact.phone ?? profile?.phone ?? undefined,
      email: draft.contact.email ?? profile?.email ?? undefined,
    };
    const missing: string[] = [];
    for (const key of ["firstName", "lastName", "phone", "email"] as const) if (!contact[key]) missing.push(`contact.${key}`);
    if (handoverOf(draft.delivery.area) === "home_delivery" && !draft.address) missing.push("address");
    if (!draft.packaging) missing.push("packagingId");
    const problems: { code: string; detail?: unknown }[] = [];
    if (!methods.includes(draft.payment.method)) problems.push({ code: "payment_method_not_offered", detail: { offered: methods } });
    if (draft.payment.method === "card" && draft.payment.cardId) {
      const card = cards.find((c) => c.cardId === draft.payment.cardId);
      if (!card) problems.push({ code: "card_not_found" });
      else if (card.expiryStatus === "expired") problems.push({ code: "card_expired" });
    }
    const unpriced = draft.items.filter((i) => i.price === null).map((i) => i.productId);
    if (unpriced.length > 0) problems.push({ code: "products_not_sold_here", detail: { productIds: unpriced } });
    return { contact, missing, problems };
  };

  const fingerprint = (draft: Draft, contact: Partial<OrderContact>, total: string | null): string =>
    createHash("sha256")
      .update(
        JSON.stringify([
          secret,
          draft.storeId,
          draft.delivery.area.areaId,
          draft.delivery.slot.slotId,
          [...draft.items].sort((a, b) => a.productId.localeCompare(b.productId)).map((i) => [i.productId, i.quantity, i.allowSubstitutes, i.note]),
          draft.packaging?.packagingId ?? null,
          draft.payment,
          contact,
          draft.address,
          draft.note,
          draft.discountCode,
          total,
        ]),
      )
      .digest("hex");

  const summaryFor = async (token: string | null, draft: Draft): Promise<{ summary: OrderSummary; source: "s-kaupat" | "estimate" }> => {
    const priced = draft.items.filter((i) => i.price !== null);
    try {
      const summary = await ctx.checkout.getOrderSummary(token, {
        slotId: draft.delivery.slot.slotId,
        reservationId: null,
        items: priced.map((i) => ({ productId: i.productId, price: i.price!, quantity: i.quantity })),
        packagingId: draft.packaging?.packagingId ?? null,
      });
      if (summary.total.length > 0) return { summary, source: "s-kaupat" };
    } catch (err) {
      log.warn("S-kaupat's order summary failed; estimating", { code: toSKaupatError(err).code });
    }
    return { summary: estimate(draft), source: "estimate" };
  };

  const paymentMethodsFor = (offered: PaymentMethod[], profile: CustomerProfile | null, fastTrack: boolean): PaymentMethod[] =>
    // The site's own rules: no invoice for consumers or express times; no card for companies without a company id.
    offered.filter((m) => {
      if (m === "invoice") return profile?.customerType === "b2b" && !fastTrack;
      if (m === "card") return !(profile?.customerType === "b2b" && !profile.companyId);
      return true;
    });

  server.registerTool(
    "get_checkout_options",
    {
      title: "Get checkout choices",
      description:
        "Everything the app needs to build its own checkout screen for the chosen store and time (select_delivery): " +
        "paymentMethods the user can use (card, invoice, on_delivery), savedCards on the account (masked), " +
        "packagingOptions with prices and the default one, contact details from the account to pre-fill, the " +
        "small-order fee and fees S-kaupat adds for this time (mandatoryProducts, e.g. the delivery fee), and whether " +
        "an address is needed (home delivery). Read-only. Needs a login.",
      inputSchema: { storeId: z.string().min(1).optional().describe("Leave out to use the chosen store.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ storeId }) =>
      ctx.run("get_checkout_options", async () => {
        const store = ctx.resolveStoreId(storeId);
        const delivery = requireDelivery(store);
        const method = handoverOf(delivery.area)!;
        const [info, packaging, mandatory, profile, cards] = await Promise.all([
          ctx.checkout.getStoreCheckoutInfo(store),
          ctx.checkout.getPackagingOptions(delivery.area.areaId),
          ctx.checkout.getMandatoryProducts(store, method, delivery.slot.slotId, null).catch((err) => {
            log.warn("Mandatory products could not be read", { code: toSKaupatError(err).code });
            return null;
          }),
          ctx.withToken((t) => ctx.checkout.getCustomerProfile(t)),
          ctx.withToken((t) => ctx.checkout.getSavedCards(t, store)),
        ]);
        return {
          storeId: store,
          storeName: ctx.storeName(store),
          delivery: ctx.deliveryView(delivery),
          paymentMethods: paymentMethodsFor(info.paymentMethods, profile, fastTrack(delivery)),
          savedCards: cards,
          packagingOptions: packaging,
          defaultPackagingId: defaultPackaging(packaging)?.packagingId ?? null,
          contact: { firstName: profile.firstName, lastName: profile.lastName, phone: profile.phone, email: profile.email },
          customerType: profile.customerType,
          needsAddress: method === "home_delivery",
          smallOrderFee: info.smallOrderFee,
          mandatoryProducts: mandatory,
          payment: {
            card: "The user pays on the payment provider's page (opened by place_order or pay_order); every card payment goes through it.",
            on_delivery: "Paid when collecting; no payment page.",
          },
        };
      }),
  );

  server.registerTool(
    "review_order",
    {
      title: "Review an order before placing it",
      description:
        "Builds the order exactly as place_order would send it and returns what the user must see before confirming: " +
        "the products with prices and per-product checks for the chosen time, the time and place, packaging, payment " +
        "method, contact details, and S-kaupat's own summary with fees and the total. ready is true when nothing is " +
        "missing; then confirmationCode lets place_order send exactly this order (valid 15 minutes, and only while " +
        "nothing changes). Read-only: nothing is reserved or ordered. Needs a login.",
      inputSchema: draftShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) =>
      ctx.run("review_order", async () => {
        const draft = await buildDraft(input);
        const [info, profile, cards, validation] = await Promise.all([
          ctx.checkout.getStoreCheckoutInfo(draft.storeId),
          ctx.withToken((t) => ctx.checkout.getCustomerProfile(t)),
          draft.payment.method === "card" ? ctx.withToken((t) => ctx.checkout.getSavedCards(t, draft.storeId)) : Promise.resolve([]),
          ctx.checkout.validateOrder(draft.storeId, draft.delivery.slot.slotId, draft.delivery.slot.date, draft.items, draft.delivery.area.areaId),
        ]);
        const methods = paymentMethodsFor(info.paymentMethods, profile, fastTrack(draft.delivery));
        const { contact, missing, problems } = complete(draft, profile, methods, cards);
        const blocked = validation.items.filter((v) => v.status !== "ok" && v.status !== "unknown");
        if (!validation.orderingPossible) problems.push({ code: "ordering_not_possible", detail: { productIds: blocked.map((b) => b.productId) } });
        const { summary, source } = await ctx.withToken((t) => summaryFor(t, draft));
        const ready = missing.length === 0 && problems.length === 0;
        let confirmationCode: string | null = null;
        if (ready) {
          confirmationCode = randomBytes(6).toString("hex");
          const total = summary.total[0]?.amount ?? null;
          reviews.set(confirmationCode, { fingerprint: fingerprint(draft, contact, total), until: ctx.now().getTime() + REVIEW_VALID_MS });
        }
        const card = draft.payment.cardId ? cards.find((c) => c.cardId === draft.payment.cardId) : null;
        return {
          ready,
          missing,
          problems,
          confirmationCode,
          expiresAt: confirmationCode ? new Date(ctx.now().getTime() + REVIEW_VALID_MS).toISOString() : null,
          storeId: draft.storeId,
          storeName: ctx.storeName(draft.storeId),
          delivery: ctx.deliveryView(draft.delivery),
          items: draft.items.map((i) => {
            const check = validation.items.find((v) => v.productId === i.productId);
            return {
              productId: i.productId,
              name: i.name,
              quantity: i.quantity,
              unitPrice: i.price,
              allowSubstitutes: i.allowSubstitutes,
              status: i.price === null ? "not_in_store" : (check?.status ?? "unknown"),
              label: check?.label ?? null,
            };
          }),
          packaging: draft.packaging,
          payment: {
            method: draft.payment.method,
            card: card ? { cardId: card.cardId, label: card.label, maskedNumber: card.maskedNumber } : null,
            newCard: draft.payment.method === "card" && !draft.payment.cardId,
            paymentPage: draft.payment.method === "card",
          },
          contact,
          address: draft.address,
          note: draft.note,
          summary,
          summarySource: source,
        };
      }),
  );

  server.registerTool(
    "place_order",
    {
      title: "Place the order",
      description:
        "Places the order the user just confirmed. Call it only after showing review_order's summary and getting the " +
        "user's explicit yes (for example an 'Order' button), with the same inputs and its confirmationCode; if " +
        "anything changed, it fails with confirmation_required and the app reviews again. It reserves the time, " +
        "checks the products, creates the order on the user's S-kaupat account, and for card payment opens the " +
        "payment provider's page (paymentPage: own_window opens it in this server's browser window; app returns the " +
        "URL for the app's own web view). Pay on delivery needs nothing more. Never retry after order_uncertain: check " +
        "get_order first. Needs a login.",
      inputSchema: {
        ...draftShape,
        confirmationCode: z.string().min(1).describe("confirmationCode from review_order."),
        paymentPage: z
          .enum(["own_window", "app", "later"])
          .default("own_window")
          .describe("Card payment: own_window opens the payment page for the user; app returns paymentUrl only; later creates no payment yet (pay_order)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ confirmationCode, paymentPage, ...input }) =>
      ctx.run("place_order", async () => {
        if (!ctx.orderingEnabled) throw new SKaupatError("orders_disabled", "place_order is turned off in this server's settings.");
        const review = reviews.get(confirmationCode);
        // Used up at once, before any await: a double-pressed Order button must not place two orders.
        reviews.delete(confirmationCode);
        if (!review || review.until < ctx.now().getTime()) {
          throw new SKaupatError("confirmation_required", "Unknown, used or expired confirmationCode; review the order again.");
        }
        const draft = await buildDraft(input);
        // Get the token once: a retried login must never send the order twice.
        const token = await ctx.auth.getAccessToken();
        const [info, profile, cards] = await Promise.all([
          ctx.checkout.getStoreCheckoutInfo(draft.storeId),
          ctx.checkout.getCustomerProfile(token),
          draft.payment.method === "card" ? ctx.checkout.getSavedCards(token, draft.storeId) : Promise.resolve([]),
        ]);
        const { contact, missing, problems } = complete(draft, profile, paymentMethodsFor(info.paymentMethods, profile, fastTrack(draft.delivery)), cards);
        if (missing.length > 0 || problems.length > 0) {
          throw new SKaupatError("order_not_ready", "The order is not complete.", { missing, problems });
        }
        const { summary } = await summaryFor(token, draft);
        if (fingerprint(draft, contact, summary.total[0]?.amount ?? null) !== review.fingerprint) {
          throw new SKaupatError("confirmation_required", "The order or its total changed after review_order.");
        }

        // Express times need no reservation; others do when logged in (the site's rule).
        const reservation = fastTrack(draft.delivery) ? null : await ctx.checkout.reserveSlot(token, draft.delivery.slot.slotId);
        const release = async () => {
          if (reservation) await ctx.checkout.releaseReservation(token, reservation.reservationId).catch(() => {});
        };
        let order;
        try {
          if (reservation) await ctx.checkout.refreshReservation(token, reservation.reservationId);
          const validation = await ctx.checkout.validateOrder(draft.storeId, draft.delivery.slot.slotId, draft.delivery.slot.date, draft.items, draft.delivery.area.areaId);
          if (!validation.orderingPossible) {
            throw new SKaupatError("ordering_not_possible", "S-kaupat does not accept this cart for the chosen time.", {
              items: validation.items.filter((v) => v.status !== "ok"),
            });
          }
          order = await ctx.checkout.createOrder(token, {
            storeId: draft.storeId,
            slotId: draft.delivery.slot.slotId,
            reservationId: reservation?.reservationId ?? null,
            items: draft.items,
            packagingId: draft.packaging!.packagingId,
            contact: contact as OrderContact,
            address: draft.address,
            payment: draft.payment.method,
            note: draft.note,
            discountCode: draft.discountCode,
          });
        } catch (err) {
          // An uncertain order may hold the reservation; keep it so the user's order, if any, keeps its time.
          if (toSKaupatError(err).code !== "order_uncertain") await release();
          throw err;
        }
        try {
          ctx.orders.save({
            orderId: order.orderId,
            orderNumber: order.orderNumber,
            accessToken: order.accessToken,
            storeId: draft.storeId,
            placedAt: ctx.now().toISOString(),
          });
        } catch (err) {
          // The order exists: report it anyway. Without its saved token, cancelling may need the S-kaupat site.
          log.warn("Could not save the order to the orders file", { code: (err as NodeJS.ErrnoException).code ?? "unknown" });
        }
        log.info("Order placed", { orderNumber: order.orderNumber, payment: draft.payment.method });
        const { accessToken: _secret, ...shown } = order;
        const payment = await startPayment(order.orderId, draft.payment, paymentPage, token);
        return { order: { ...shown, summary }, payment, nextStep: nextStepFor(shown.payment === "not_needed" ? "placed" : payment.status) };
      }),
  );

  /** Card payment: the provider's page, in the server's window or for the app's own web view. */
  const startPayment = async (
    orderId: string,
    payment: { method: PaymentMethod; cardId: string | null; saveCard: boolean },
    page: "own_window" | "app" | "later",
    token: string,
  ) => {
    if (payment.method !== "card") return { required: false, status: "not_needed" as const, url: null, openedInWindow: false };
    if (page === "later") return { required: true, status: "not_started" as const, url: null, openedInWindow: false };
    try {
      const url = await ctx.checkout.createPayment(token, orderId, payment.cardId, payment.saveCard);
      let opened = false;
      if (page === "own_window" && ctx.openWindow) {
        await ctx.openWindow(url).then(
          () => (opened = true),
          (err) => log.warn("Could not open the payment page", { code: toSKaupatError(err).code }),
        );
      }
      return {
        required: true,
        status: "payment_page" as const,
        url,
        openedInWindow: opened,
        returnUrlPrefix: `${PAYMENT_RETURN_PREFIX}${orderId}`,
      };
    } catch (err) {
      // The order exists either way; the app offers pay_order or cancel_order.
      const e = toSKaupatError(err);
      return { required: true, status: "payment_not_started" as const, url: null, openedInWindow: false, error: { code: e.code, message: e.message } };
    }
  };

  const orderToken = (orderId: string): string | null => ctx.orders.get(orderId)?.accessToken ?? null;

  const requireOrder = async (token: string, orderId: string): Promise<OrderInfo> => {
    const order = await ctx.checkout.getOrder(token, orderId, orderToken(orderId));
    if (!order) throw new SKaupatError("order_not_found", `Order ${orderId} was not found.`, { orderId });
    return order;
  };

  server.registerTool(
    "pay_order",
    {
      title: "Pay an order by card",
      description:
        "Opens the payment provider's page for an order that is waiting for card payment (after place_order with " +
        "paymentPage later, a cancelled or failed payment, or when the user wants another card). get_order then shows " +
        "when it is paid. Needs a login.",
      inputSchema: {
        orderId: z.string().min(1),
        cardId: z.string().min(1).optional().describe("A saved card; leave out for a new card."),
        saveCard: z.boolean().default(false),
        paymentPage: z.enum(["own_window", "app"]).default("own_window"),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ orderId, cardId, saveCard, paymentPage }) =>
      ctx.run("pay_order", async () => {
        const token = await ctx.auth.getAccessToken();
        const order = await requireOrder(token, orderId);
        if (order.paymentMethod !== "card" || !["awaiting_payment", "payment_failed"].includes(order.payment)) {
          throw new SKaupatError("invalid_argument", `Order ${orderId} is not waiting for a card payment (${order.payment}).`);
        }
        const payment = await startPayment(orderId, { method: "card", cardId: cardId ?? null, saveCard }, paymentPage, token);
        return { order, payment, nextStep: nextStepFor(payment.status) };
      }),
  );

  server.registerTool(
    "confirm_payment",
    {
      title: "Confirm a card payment",
      description:
        "Only when the app showed the payment page itself (paymentPage app): once its web view reaches returnUrlPrefix " +
        "with responseCode=OK, call this so S-kaupat authorises the payment. Not needed with own_window, where " +
        "S-kaupat's own page does it. Returns the order; payment paid means done.",
      inputSchema: { orderId: z.string().min(1) },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ orderId }) =>
      ctx.run("confirm_payment", async () => {
        const token = await ctx.auth.getAccessToken();
        const before = await requireOrder(token, orderId);
        if (before.payment !== "paid" && before.payment !== "charged") {
          const authorized = await ctx.checkout.authorizePayment(token, orderId);
          if (!authorized) throw new SKaupatError("payment_failed", "S-kaupat did not authorise the payment.", { orderId });
        }
        const order = await requireOrder(token, orderId);
        return { order, nextStep: nextStepFor(order.payment === "paid" || order.payment === "charged" ? "paid" : "payment_page") };
      }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get an order's status",
      description:
        "An order's status: state (received, being_picked, done, cancelled) and payment (awaiting_payment, paid, " +
        "charged, payment_failed, payment_link, not_needed, cancelled), with S-kaupat's own summary and whether it can " +
        "still be cancelled. Without orderId: the orders placed through this app, newest first. After the payment page, " +
        "call it to see when the payment went through. Needs a login.",
      inputSchema: { orderId: z.string().min(1).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ orderId }) =>
      ctx.run("get_order", async () => {
        if (orderId) {
          const order = await ctx.withToken((t) => requireOrder(t, orderId));
          return { order, nextStep: nextStepFor(order.state === "cancelled" ? "cancelled" : order.payment === "awaiting_payment" ? "payment_page" : "placed") };
        }
        return {
          orders: ctx.orders.list().map((r) => ({ orderId: r.orderId, orderNumber: r.orderNumber, storeId: r.storeId, placedAt: r.placedAt })),
        };
      }),
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel an order",
      description:
        "Cancels an order placed through this app, while S-kaupat still allows it (get_order isCancelable). Ask the user " +
        "to confirm first. A card payment that was authorised is released by S-kaupat. Needs a login.",
      inputSchema: { orderId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ orderId }) =>
      ctx.run("cancel_order", async () => {
        const token = await ctx.auth.getAccessToken();
        const before = await requireOrder(token, orderId);
        if (before.state === "cancelled") return { order: before, cancelled: true };
        if (before.isCancelable === false) {
          throw new SKaupatError("invalid_argument", `Order ${orderId} can no longer be cancelled.`, { orderId, reason: "not_cancelable" });
        }
        await ctx.checkout.cancelOrder(token, orderId, orderToken(orderId));
        const order = await requireOrder(token, orderId);
        log.info("Order cancelled", { orderNumber: order.orderNumber });
        return { order, cancelled: order.state === "cancelled" };
      }),
  );
}

/** Express (Pikatoimitus) area or a fast-track time: the site reserves nothing and offers no invoice. */
function fastTrack(delivery: SavedDelivery): boolean {
  return delivery.area.method === "express" || delivery.slot.express;
}

function defaultPackaging(options: PackagingOption[]): PackagingOption | null {
  // The site's default: the first material that is not a deposit bag.
  return options.find((p) => p.type !== "deposit_bag") ?? options[0] ?? null;
}

/** When S-kaupat's own summary is not available: products, the time's fee and packaging, in euros. */
function estimate(draft: Draft): OrderSummary {
  const euros = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;
  const products = draft.items.reduce((sum, i) => sum + (i.price ?? 0) * i.quantity, 0);
  const fee = draft.delivery.slot.price ?? 0;
  const packaging = draft.packaging?.price ?? 0;
  return {
    products: [{ title: "Tuotteet (arvio)", amount: euros(products) }],
    smallOrderFee: [],
    serviceFees: [
      { title: handoverOf(draft.delivery.area) === "pickup" ? "Noutomaksu" : "Toimitusmaksu", amount: euros(fee) },
      ...(packaging ? [{ title: "Pakkausmateriaali (arvio)", amount: euros(packaging) }] : []),
    ],
    discounts: [],
    total: [{ title: "Yhteensä (arvio)", amount: euros(products + fee + packaging) }],
    disclaimer: "Arvio: S-kaupan oma yhteenveto ei ollut saatavilla. Punnittavat tuotteet veloitetaan todellisen painon mukaan.",
  };
}

const NEXT_STEPS = {
  placed: {
    code: "placed",
    fi: "Tilaus on vastaanotettu. Saat vahvistuksen sähköpostiisi.",
    en: "The order has been received. A confirmation is on its way to your email.",
  },
  payment_page: {
    code: "pay",
    fi: "Maksa tilaus avautuneella maksusivulla. Tilaus on valmis, kun maksu on hyväksytty.",
    en: "Pay on the payment page that opened. The order is complete once the payment is accepted.",
  },
  payment_not_started: {
    code: "pay",
    fi: "Tilaus on tehty, mutta maksua ei voitu aloittaa. Yritä maksaa uudelleen.",
    en: "The order was placed but the payment could not start. Please try paying again.",
  },
  not_started: {
    code: "pay",
    fi: "Tilaus on tehty. Maksa se ennen toimitusta.",
    en: "The order is placed. Please pay for it before delivery.",
  },
  paid: { code: "done", fi: "Maksu on hyväksytty. Kiitos tilauksesta!", en: "The payment was accepted. Thank you for your order!" },
  cancelled: { code: "cancelled", fi: "Tilaus on peruttu.", en: "The order has been cancelled." },
  not_needed: { code: "placed", fi: "Tilaus on vastaanotettu.", en: "The order has been received." },
} as const;

function nextStepFor(status: keyof typeof NEXT_STEPS) {
  const { code, fi, en } = NEXT_STEPS[status];
  return { code, message: { fi, en } };
}
