interface Order {
  id: string;
  sku: string;
  quantity: number;
}

export function createRepo() {
  return {
    async insertOrder(order: Omit<Order, "id">): Promise<Order> {
      return { id: crypto.randomUUID(), ...order };
    },
  };
}

export function createFakeRepo() {
  const orders: Order[] = [];
  return {
    orders,
    async insertOrder(order: Omit<Order, "id">): Promise<Order> {
      const created = { id: `fake-${orders.length}`, ...order };
      orders.push(created);
      return created;
    },
  };
}
