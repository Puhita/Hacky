export const users = [];
export const orders = [];

export function createUser(id, email) {
  const user = { id, email };
  users.push(user);
  return user;
}

export function createOrder(id, userId, total) {
  const order = { id, userId, total };
  orders.push(order);
  return order;
}
