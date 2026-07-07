export const orderSchema = {
  safeParse(body: unknown) {
    if (
      typeof body === "object" &&
      body !== null &&
      typeof (body as { sku?: unknown }).sku === "string" &&
      typeof (body as { quantity?: unknown }).quantity === "number"
    ) {
      return { success: true as const, data: body as { sku: string; quantity: number } };
    }
    return { success: false as const };
  },
};
