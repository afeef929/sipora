import { getStore } from '@netlify/blobs';

const STORE_NAME = 'sipora-orders';
const KEY = 'orders.json';
const PRODUCT_STORE_NAME = 'sipora-products';
const PRODUCT_KEY = 'products.json';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function readOrders() {
  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  return (await store.get(KEY, { type: 'json', consistency: 'strong' })) || [];
}

async function writeOrders(orders) {
  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  await store.setJSON(KEY, orders);
}

async function readProducts() {
  const store = getStore({ name: PRODUCT_STORE_NAME, consistency: 'strong' });
  return (await store.get(PRODUCT_KEY, { type: 'json', consistency: 'strong' })) || [];
}

async function writeProducts(products) {
  const store = getStore({ name: PRODUCT_STORE_NAME, consistency: 'strong' });
  await store.setJSON(PRODUCT_KEY, products);
}

function statusStep(status) {
  return status === 'Confirmed' ? 1 : status === 'Preparing' ? 2 : status === 'Ready for pickup' ? 3 : status === 'Out for delivery' ? 4 : status === 'Delivered' ? 5 : 0;
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const id = parts[parts.length - 1];
    const isTracking = parts.length >= 3 && parts[parts.length - 1] === 'tracking';
    const orderId = isTracking ? parts[parts.length - 2] : null;

    if (req.method === 'GET' && !isTracking && id === 'products') return json(await readProducts());

    if (req.method === 'GET' && !isTracking) return json(await readOrders());

    if (req.method === 'POST' && !isTracking && id === 'products') {
      const product = await req.json();
      if (!product?.id || !product?.name) return json({ error: 'Product id and name are required' }, 400);
      const products = await readProducts();
      const index = products.findIndex(x => String(x.id) === String(product.id));
      const saved = { ...(index >= 0 ? products[index] : {}), ...product, serverUpdatedAt: new Date().toISOString() };
      if (index >= 0) products[index] = saved; else products.unshift(saved);
      await writeProducts(products);
      return json(saved);
    }

    if (req.method === 'DELETE' && !isTracking && id === 'products') {
      const products = await readProducts();
      const productId = url.searchParams.get('id');
      if (!productId) return json({ error: 'Product id is required' }, 400);
      const next = products.filter(x => String(x.id) !== String(productId));
      await writeProducts(next);
      return json({ ok: true, id: productId });
    }

    if (req.method === 'DELETE' && !isTracking && id === 'orders') {
      await writeOrders([]);
      return json({ ok: true, cleared: true });
    }

    if (req.method === 'POST' && !isTracking) {
      const order = await req.json();
      if (!order?.id) return json({ error: 'Order id is required' }, 400);
      const orders = await readOrders();
      const index = orders.findIndex(x => x.id === order.id);
      const saved = {
        ...(index >= 0 ? orders[index] : {}),
        ...order,
        serverUpdatedAt: new Date().toISOString()
      };
      if (index >= 0) orders[index] = saved; else orders.unshift(saved);
      await writeOrders(orders);
      return json(saved);
    }

    if (req.method === 'PATCH' && !isTracking && id !== 'products') {
      const patch = await req.json();
      const orders = await readOrders();
      const index = orders.findIndex(x => x.id === id);
      if (index < 0) return json({ error: 'Order not found' }, 404);
      orders[index] = { ...orders[index], ...patch, serverUpdatedAt: new Date().toISOString() };
      if (patch.status) orders[index].statusStep = statusStep(patch.status);
      await writeOrders(orders);
      return json(orders[index]);
    }

    if (isTracking && req.method === 'GET') {
      const orders = await readOrders();
      const order = orders.find(x => x.id === orderId);
      if (!order) return json({ error: 'Order not found' }, 404);
      return json({
        id: order.id,
        status: order.status || 'Confirmed',
        statusStep: Number(order.statusStep || statusStep(order.status)),
        lat: order.driverLat ?? null,
        lng: order.driverLng ?? null,
        updatedAt: order.trackingUpdatedAt || order.statusUpdatedAt || order.serverUpdatedAt || null,
        currentSituation: order.currentSituation || null
      });
    }

    if (isTracking && req.method === 'PATCH') {
      const patch = await req.json();
      const lat = Number(patch.lat);
      const lng = Number(patch.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return json({ error: 'Valid latitude and longitude are required' }, 400);
      }
      const orders = await readOrders();
      const index = orders.findIndex(x => x.id === orderId);
      if (index < 0) return json({ error: 'Order not found' }, 404);
      const now = new Date().toISOString();
      orders[index] = { ...orders[index], driverLat: lat, driverLng: lng, trackingUpdatedAt: now, serverUpdatedAt: now };
      await writeOrders(orders);
      return json({ id: orderId, lat, lng, status: orders[index].status, statusStep: orders[index].statusStep, currentSituation: orders[index].currentSituation || null, updatedAt: now });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('SIPORA orders function error:', error);
    return json({ error: 'Server error', message: error?.message || String(error) }, 500);
  }
}

export const config = { path: ['/api/orders', '/api/orders/:id', '/api/orders/:id/tracking', '/api/products'] };
