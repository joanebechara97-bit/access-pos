require('dotenv').config();
const BUSINESS_TIME_ZONE = process.env.BUSINESS_TIME_ZONE || 'Asia/Beirut';
if (!process.env.TZ) {
  process.env.TZ = BUSINESS_TIME_ZONE;
}
const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const session = require('express-session');
const pg = require('pg');
const connectPgSimple = require('connect-pg-simple');
const axios = require('axios');

const app = express();

const SALON_API_BASE = process.env.SALON_API_BASE || 'http://localhost:4000/api';
const SALON_TIMEOUT_MS = Number(process.env.SALON_TIMEOUT_MS || 10000);
const POS_ITEMS_CACHE_MS = Number(process.env.POS_ITEMS_CACHE_MS || 30000);
const port = process.env.PORT || 10000;

axios.defaults.timeout = SALON_TIMEOUT_MS;
axios.defaults.httpAgent = new http.Agent({ keepAlive: true });
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true });

function formatBusinessDateTime(dateValue) {
  if (!dateValue) return '-';

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(new Date(dateValue));
}

// ----------------------
// App config
// ----------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

const staticOptions = {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : '1h'
};

app.use(express.static(path.join(__dirname, 'public'), staticOptions));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), staticOptions));
app.get('/assets/logo-ss-png.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'logo-ss-png.png'), { maxAge: staticOptions.maxAge });
});
app.get('/assets/job-logo-png.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'job-logo-png.png'), { maxAge: staticOptions.maxAge });
});
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ----------------------
// Session
// ----------------------
function createSessionMiddleware(store) {
  return session({
    ...(store ? { store } : {}),
    secret: process.env.SESSION_SECRET || 'possecret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 12
    }
  });
}

let sessionMiddleware = createSessionMiddleware();

if (process.env.DATABASE_URL) {
  try {
    const pgSession = connectPgSimple(session);
    const pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    pgPool.on('error', (error) => {
      console.error('Session database pool error, continuing with current sessions:', error.message);
    });

    const store = new pgSession({
      pool: pgPool,
      tableName: 'user_sessions',
      createTableIfMissing: true
    });

    if (typeof store.on === 'function') {
      store.on('error', (error) => {
        console.error('Session store error, requests will keep using existing middleware:', error.message);
      });
    }

    sessionMiddleware = createSessionMiddleware(store);
  } catch (error) {
    console.error('Failed to initialize Postgres session store, falling back to memory sessions:', error.message);
  }
}

app.use((req, res, next) => {
  sessionMiddleware(req, res, (error) => {
    if (error) {
      console.error('Session middleware failure, retrying with memory session store:', error.message);
      const fallbackMiddleware = createSessionMiddleware();
      return fallbackMiddleware(req, res, next);
    }
    return next();
  });
});

// ----------------------
// Locals
// ----------------------
app.use((req, res, next) => {
  res.locals.user = req.session?.user || null;
  res.locals.currentUser = req.session?.user || null;
  res.locals.businessTimeZone = BUSINESS_TIME_ZONE;
  res.locals.formatBusinessDateTime = formatBusinessDateTime;
  next();
});

// ----------------------
// Helpers
// ----------------------
function getCurrentUser(req, res) {
  return req.session?.user || res.locals.user || null;
}

function requireLogin(req, res, next) {
  if (req.session?.user?.token) return next();
  return res.redirect('/login');
}

function requirePerm(key) {
  return function (req, res, next) {
    const u = getCurrentUser(req, res);
    if (!u) return res.redirect('/login');

    if (u.perms && u.perms[key]) return next();

    return res.status(403).render('access_denied', {
      message: 'Permission denied'
    });
  };
}

function getSessionOpenKey(req, res) {
  const currentUser = getCurrentUser(req, res);
  const userId = currentUser?.email || currentUser?.id || 'anonymous';
  return `cabine:${userId}`;
}

const posItemsCache = new Map();

function getItemsCacheKey(req) {
  const user = req.session?.user || {};
  return user.businessId || user.business?.id || user.email || 'default';
}

function clearSalonItemCache() {
  posItemsCache.clear();
}

function getSessionDay(req) {
  return req.session?.posDay || null;
}

function isSessionDayOpen(req) {
  const sessionDay = getSessionDay(req);
  return Boolean(sessionDay && sessionDay.isOpen);
}

function formatMoneyFromCents(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function buildQueryString(queryObj = {}) {
  const params = new URLSearchParams();

  Object.entries(queryObj).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      params.set(key, String(value));
    }
  });

  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
function getInvoiceNumber(sale) {
  if (sale?.invoiceNumber) return sale.invoiceNumber

  const dateValue = sale?.confirmedAt || sale?.createdAt || new Date()
  const d = new Date(dateValue)

  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const tail = String(sale?.id || '').slice(-6).toUpperCase()

  return `INV-${y}${m}${day}-${tail || '000000'}`
}

async function salonRequest(reqLike, urlPath, options = {}) {
  const token = reqLike?.session?.user?.token;
  const timeoutMs = Number(options.timeoutMs || SALON_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const { timeoutMs: _timeoutMs, ...fetchOptions } = options;

  let response;
  try {
    response = await fetch(`${SALON_API_BASE}${urlPath}`, {
      ...fetchOptions,
      headers,
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Salon backend timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

async function fetchSalonItems(req) {
  const cacheKey = getItemsCacheKey(req);
  const cached = posItemsCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.items;
  }

  const result = await salonRequest(req, '/pos/items');

  if (!result.ok) {
    throw new Error(
      result.data?.message ||
        result.data?.error ||
        (typeof result.data === 'string' ? result.data : 'Failed to load POS items')
    );
  }

  const items = Array.isArray(result.data) ? result.data : [];

  const mappedItems = items.map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    priceCents: Number(item.priceCents || 0),
    price: Number(item.priceCents || 0) / 100,
    isActive: item.isActive !== false
  }));

  posItemsCache.set(cacheKey, {
    expiresAt: Date.now() + POS_ITEMS_CACHE_MS,
    items: mappedItems
  });

  return mappedItems;
}

function findItemByCategory(items, category) {
  const normalized = String(category || '').trim().toLowerCase();

  return items.find(
    (item) => String(item.name || '').trim().toLowerCase() === normalized
  );
}

function extractSalesArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.sales)) return payload.sales;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function renderSimpleReportPage(title, sales, totalCents) {
const rowsHtml = sales.length
  ? sales
      .map((sale) => {
        const dateValue =
          sale.confirmedAt ||
          sale.voidedAt ||
          sale.createdAt ||
          sale.date ||
          null

        const dateText = formatBusinessDateTime(dateValue)

        const itemsText = Array.isArray(sale.lines) && sale.lines.length
          ? sale.lines
              .map((line) => {
                const itemName =
                  line.service?.name ||
                  line.product?.name ||
                  line.posItem?.name ||
                  'Item'

                return `${itemName} x${line.qty}`
              })
              .join(', ')
          : '-'

        return `
          <tr>
            <td style="padding:10px;border-top:1px solid #e5e7eb;">${dateText}</td>
            <td style="padding:10px;border-top:1px solid #e5e7eb;">${getInvoiceNumber(sale)}</td>
            <td style="padding:10px;border-top:1px solid #e5e7eb;">${itemsText}</td>
            <td style="padding:10px;border-top:1px solid #e5e7eb;">${sale.status || '-'}</td>
            <td style="padding:10px;border-top:1px solid #e5e7eb;text-align:right;">${formatMoneyFromCents(sale.totalCents || 0)}</td>
          </tr>
        `
      })
      .join('')
  : `
    <tr>
      <td colspan="5" style="padding:16px;text-align:center;color:#64748b;">
        No records found
      </td>
    </tr>
  `;

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <title>${title}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body {
          margin: 0;
          font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
          background: #f8fafc;
          color: #0f172a;
        }
        .wrap {
          max-width: 1100px;
          margin: 0 auto;
          padding: 24px 16px 40px;
        }
        .card {
          background: #fff;
          border-radius: 18px;
          box-shadow: 0 8px 24px rgba(15,23,42,.06);
          padding: 20px;
        }
        .top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 18px;
          flex-wrap: wrap;
        }
        .title {
          font-size: 28px;
          font-weight: 800;
          margin: 0;
        }
        .muted {
          color: #64748b;
          font-size: 14px;
          margin-top: 6px;
        }
        .summary {
          display: grid;
          grid-template-columns: repeat(2, minmax(180px, 1fr));
          gap: 14px;
          margin-bottom: 18px;
        }
        .box {
          border-radius: 16px;
          background: #f8fafc;
          padding: 16px;
        }
        .box-label {
          font-size: 12px;
          text-transform: uppercase;
          color: #64748b;
          font-weight: 700;
          margin-bottom: 6px;
        }
        .box-value {
          font-size: 28px;
          font-weight: 800;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          background: #fff;
        }
        thead th {
          text-align: left;
          font-size: 12px;
          text-transform: uppercase;
          color: #64748b;
          background: #f8fafc;
          padding: 12px 10px;
        }
        .actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .btn {
          border: none;
          border-radius: 12px;
          padding: 10px 14px;
          background: #111827;
          color: #fff;
          text-decoration: none;
          font-weight: 700;
          cursor: pointer;
        }
        .btn.secondary {
          background: #fff;
          color: #0f172a;
          box-shadow: inset 0 0 0 1px #d1d5db;
        }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="card">
          <div class="top">
            <div>
              <h1 class="title">${title}</h1>
              <div class="muted">Cabine frontend using salon-project backend</div>
            </div>
            <div class="actions">
              <a class="btn secondary" href="/pos">Back to POS</a>
              <button class="btn" onclick="window.print()">Print</button>
            </div>
          </div>

          <div class="summary">
            <div class="box">
              <div class="box-label">Sales Count</div>
              <div class="box-value">${sales.length}</div>
            </div>
            <div class="box">
              <div class="box-label">Total</div>
              <div class="box-value">${formatMoneyFromCents(totalCents || 0)}</div>
            </div>
          </div>

          <table>
            <thead>
              <tr>
  <th>Date</th>
  <th>Reference</th>
  <th>Items</th>
  <th>Status</th>
  <th style="text-align:right;">Total</th>
</tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    </body>
    </html>
  `;
}

// ----------------------
// Routes
// ----------------------
app.get('/', (req, res) => res.redirect('/login'));

app.get('/login', (req, res) => {
  if (req.session?.user?.token) {
    return res.redirect('/pos');
  }

  return res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '').trim();

  if (!email || !password) {
    return res.render('login', {
      error: 'Email and password are required.'
    });
  }

  try {
    const result = await salonRequest(
      { session: {} },
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      }
    );

    if (!result.ok) {
      return res.render('login', {
        error:
          result.data?.message ||
          result.data?.error ||
          'Invalid credentials'
      });
    }

    if (result.data.user?.business?.name !== 'San Stephano') {
      return res.render('login', {
        error: 'This system is restricted to San Stephano.'
      });
    }

    req.session.user = {
      token: result.data.access_token,
      email: result.data.user?.email || email,
      id: result.data.user?.id || null,
      businessId: result.data.user?.businessId || null,
      business: result.data.user?.business || null,
      role: result.data.user?.role?.name || null,
      perms:
        result.data.user?.permissions ||
        result.data.user?.role?.permissions ||
        {}
    };

    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.render('login', {
          error: 'Could not save login session.'
        });
      }

      return res.redirect('/pos');
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.render('login', {
      error: 'Server error during login.'
    });
  }
});

app.get('/admin/users', requireLogin, requirePerm('canManageUsers'), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase()

    const response = await axios.get(`${SALON_API_BASE}/users${buildQueryString({ q })}`, {
      headers: {
        Authorization: `Bearer ${req.session.user.token}`
      }
    })

    let users = []

    if (Array.isArray(response.data)) {
      users = response.data
    } else if (Array.isArray(response.data?.users)) {
      users = response.data.users
    } else if (Array.isArray(response.data?.data)) {
      users = response.data.data
    }

    users = users.map((u) => ({
      id: u.id,
      email: u.email || '',
      username: u.username || '',
      name: u.name || '',
      role: u.role?.name || u.role || '',
      active:
        typeof u.active !== 'undefined'
          ? u.active
          : typeof u.isActive !== 'undefined'
          ? u.isActive
          : true,
      isActive:
        typeof u.isActive !== 'undefined'
          ? u.isActive
          : typeof u.active !== 'undefined'
          ? u.active
          : true,
      createdAt: u.createdAt || u.created_at || null,
      permissions: u.permissions || {},
      raw: u
    }))

    return res.render('admin_users', {
      title: 'Users',
      message: null,
      q: req.query.q || '',
      users,
      found: null,
      user: req.session.user,
      currentUser: req.session.user
    })
  } catch (err) {
    console.error('LOAD USERS ERROR DATA:', err.response?.data)
    console.error('LOAD USERS ERROR STATUS:', err.response?.status)
    console.error('LOAD USERS ERROR MESSAGE:', err.message)

    return res.render('admin_users', {
      title: 'Users',
      message: JSON.stringify(err.response?.data || err.message),
      q: req.query.q || '',
      users: [],
      found: null,
      user: req.session.user,
      currentUser: req.session.user
    })
  }
})

app.post('/admin/users', requireLogin, requirePerm('canManageUsers'), async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      canAccessPOS,
      canConfirmOrder,
      canNewCustomer,
      canViewDailyReport,
      canViewMonthlyReport,
      canViewVoidedReport,
      canPrintReports,
      canRefundInvoice,
      canApplyDiscount,
      canVoidOrder,
      canManageItems,
      canManageUsers,
      canManageSettings
    } = req.body;

    const perms = {
      canAccessPOS: !!canAccessPOS,
      canConfirmOrder: !!canConfirmOrder,
      canNewCustomer: !!canNewCustomer,
      canViewDailyReport: !!canViewDailyReport,
      canViewMonthlyReport: !!canViewMonthlyReport,
      canViewVoidedReport: !!canViewVoidedReport,
      canPrintReports: !!canPrintReports,
      canRefundInvoice: !!canRefundInvoice,
      canApplyDiscount: !!canApplyDiscount,
      canVoidOrder: !!canVoidOrder,
      canManageItems: !!canManageItems,
      canManageUsers: !!canManageUsers,
      canManageSettings: !!canManageSettings
    };

    await axios.post(
      `${SALON_API_BASE}/auth/register`,
      {
        name,
        email,
        password,
        businessId: req.session.user.businessId,
        permissions: perms
      },
      {
        headers: {
          Authorization: `Bearer ${req.session.user.token}`
        }
      }
    );

    return res.redirect('/admin/users');
  } catch (err) {
    console.error('Create user error data:', err.response?.data);
    console.error('Create user error status:', err.response?.status);
    console.error('Create user error full:', err.message);

    const perms = {
      canAccessPOS: !!req.body.canAccessPOS,
      canConfirmOrder: !!req.body.canConfirmOrder,
      canNewCustomer: !!req.body.canNewCustomer,
      canViewDailyReport: !!req.body.canViewDailyReport,
      canViewMonthlyReport: !!req.body.canViewMonthlyReport,
      canViewVoidedReport: !!req.body.canViewVoidedReport,
      canPrintReports: !!req.body.canPrintReports,
      canRefundInvoice: !!req.body.canRefundInvoice,
      canApplyDiscount: !!req.body.canApplyDiscount,
      canVoidOrder: !!req.body.canVoidOrder,
      canManageItems: !!req.body.canManageItems,
      canManageUsers: !!req.body.canManageUsers,
      canManageSettings: !!req.body.canManageSettings
    };

    return res.render('admin_user_new', {
      title: 'New User',
      message: null,
      error: JSON.stringify(err.response?.data, null, 2) || err.message,
      form: {
        name: req.body.name || '',
        email: req.body.email || '',
        role: req.body.role || 'FRONT_DESK',
        isActive: !!req.body.isActive,
        perms: perms
      },
      p: perms,
      permissionLabels: {
        canAccessPOS: 'Access POS',
        canConfirmOrder: 'Confirm Order',
        canNewCustomer: 'New Customer',
        canViewDailyReport: 'View Daily Report',
        canViewMonthlyReport: 'View Monthly Report',
        canViewVoidedReport: 'View Voided Report',
        canPrintReports: 'Print Reports',
        canRefundInvoice: 'Refund Invoice',
        canApplyDiscount: 'Apply Discount',
        canVoidOrder: 'Void Order',
        canManageItems: 'Manage Items',
        canManageUsers: 'Manage Users',
        canManageSettings: 'Manage Settings'
      },
      user: req.session.user,
      currentUser: req.session.user
    });
  }
});

app.get('/admin/users/new', requireLogin, requirePerm('canManageUsers'), (req, res) => {
  return res.render('admin_user_new', {
    title: 'New User',
    message: null,
    error: null,
    form: {
      name: '',
      email: '',
      role: 'FRONT_DESK',
      isActive: true,
      perms: {}
    },
    p: {},
    permissionLabels: {
      canAccessPOS: 'Access POS',
      canConfirmOrder: 'Confirm Order',
      canNewCustomer: 'New Customer',
      canViewDailyReport: 'View Daily Report',
      canViewMonthlyReport: 'View Monthly Report',
      canViewVoidedReport: 'View Voided Report',
      canPrintReports: 'Print Reports',
      canRefundInvoice: 'Refund Invoice',
      canApplyDiscount: 'Apply Discount',
      canVoidOrder: 'Void Order',
      canManageItems: 'Manage Items',
      canManageUsers: 'Manage Users',
      canManageSettings: 'Manage Settings'
    },
    user: req.session.user,
    currentUser: req.session.user
  });
});

app.get('/admin/users/:id/edit', requireLogin, requirePerm('canManageUsers'), async (req, res) => {
  try {
    const response = await axios.get(`${SALON_API_BASE}/users/${req.params.id}`, {
      headers: {
        Authorization: `Bearer ${req.session.user.token}`
      }
    });

    const editUser = response.data?.user || response.data?.data || response.data;

    if (!editUser) {
      return res.render('admin_users', {
        title: 'Users',
        message: 'User not found',
        q: '',
        users: [],
        found: null,
        user: req.session.user,
        currentUser: req.session.user
      });
    }

    const userPerms =
      typeof editUser.permissions === 'string'
        ? JSON.parse(editUser.permissions || '{}')
        : editUser.permissions || {};

    const rolePerms =
      typeof editUser.role?.permissions === 'string'
        ? JSON.parse(editUser.role.permissions || '{}')
        : editUser.role?.permissions || {};

    const perms = Object.keys(userPerms).length ? userPerms : rolePerms;

    return res.render('admin_user_edit', {
      title: 'Edit User',
      message: null,
      error: null,
      editUser,
      userRecord: editUser,
      editUserId: req.params.id,
      form: {
        name: editUser.name || '',
        email: editUser.email || '',
        role: editUser.role?.name || editUser.role || 'FRONT_DESK',
        isActive:
          typeof editUser.active !== 'undefined'
            ? editUser.active
            : typeof editUser.isActive !== 'undefined'
            ? editUser.isActive
            : true,
        perms: perms
      },
      p: perms,
      permissionLabels: {
        canAccessPOS: 'Access POS',
        canConfirmOrder: 'Confirm Order',
        canNewCustomer: 'New Customer',
        canViewDailyReport: 'View Daily Report',
        canViewMonthlyReport: 'View Monthly Report',
        canViewVoidedReport: 'View Voided Report',
        canPrintReports: 'Print Reports',
        canRefundInvoice: 'Refund Invoice',
        canApplyDiscount: 'Apply Discount',
        canVoidOrder: 'Void Order',
        canManageItems: 'Manage Items',
        canManageUsers: 'Manage Users',
        canManageSettings: 'Manage Settings'
      },
      user: req.session.user,
      currentUser: req.session.user
    });
  } catch (err) {
    console.error('LOAD EDIT USER ERROR:', err.response?.data || err.message);

    return res.render('admin_users', {
      title: 'Users',
      message: 'Failed to load user',
      q: '',
      users: [],
      found: null,
      user: req.session.user,
      currentUser: req.session.user
    });
  }
});

app.post('/admin/users/:id/toggle', requireLogin, requirePerm('canManageUsers'), async (req, res) => {
  try {
    const response = await axios.get(`${SALON_API_BASE}/users/${req.params.id}`, {
      headers: {
        Authorization: `Bearer ${req.session.user.token}`
      }
    })

    const targetUser = response.data?.user || response.data?.data || response.data

    if (!targetUser) {
      return res.redirect('/admin/users')
    }

    const currentActive =
      typeof targetUser.active !== 'undefined'
        ? targetUser.active
        : typeof targetUser.isActive !== 'undefined'
        ? targetUser.isActive
        : true

    if (currentActive) {
      await axios.post(
        `${SALON_API_BASE}/users/${req.params.id}/deactivate`,
        {},
        {
          headers: {
            Authorization: `Bearer ${req.session.user.token}`
          }
        }
      )
    } else {
      await axios.put(
        `${SALON_API_BASE}/users/${req.params.id}`,
        { active: true },
        {
          headers: {
            Authorization: `Bearer ${req.session.user.token}`
          }
        }
      )
    }

    return res.redirect('/admin/users')
  } catch (err) {
    console.error('TOGGLE USER ERROR DATA:', err.response?.data)
    console.error('TOGGLE USER ERROR STATUS:', err.response?.status)
    console.error('TOGGLE USER ERROR MESSAGE:', err.message)
    return res.redirect('/admin/users')
  }
})

app.post('/admin/users/:id/delete', requireLogin, requirePerm('canManageUsers'), async (req, res) => {
  try {
    await axios.delete(`${SALON_API_BASE}/users/${req.params.id}`, {
      headers: {
        Authorization: `Bearer ${req.session.user.token}`
      }
    })

    return res.redirect('/admin/users')
  } catch (err) {
    console.error('DELETE USER ERROR:', err.response?.data || err.message)
    return res.redirect('/admin/users')
  }
})

app.post('/admin/users/:id/edit', requireLogin, requirePerm('canManageUsers'), async (req, res) => {
  try {
    const { name, email, roleId, isActive, password } = req.body

    const permissions = {
      canAccessPOS: !!req.body.canAccessPOS,
      canConfirmOrder: !!req.body.canConfirmOrder,
      canNewCustomer: !!req.body.canNewCustomer,
      canViewDailyReport: !!req.body.canViewDailyReport,
      canViewMonthlyReport: !!req.body.canViewMonthlyReport,
      canViewVoidedReport: !!req.body.canViewVoidedReport,
      canPrintReports: !!req.body.canPrintReports,
      canRefundInvoice: !!req.body.canRefundInvoice,
      canApplyDiscount: !!req.body.canApplyDiscount,
      canVoidOrder: !!req.body.canVoidOrder,
      canManageItems: !!req.body.canManageItems,
      canManageUsers: !!req.body.canManageUsers,
      canManageSettings: !!req.body.canManageSettings
    }

    await axios.put(
      `${SALON_API_BASE}/users/${req.params.id}`,
      {
        name,
        email,
        roleId: roleId || null,
        active: !!isActive,
        password: password || undefined,
        permissions
      },
      {
        headers: {
          Authorization: `Bearer ${req.session.user.token}`
        }
      }
    )

    return res.redirect('/admin/users')
  } catch (err) {
    console.error('EDIT USER ERROR DATA:', err.response?.data)
    console.error('EDIT USER ERROR STATUS:', err.response?.status)
    console.error('EDIT USER ERROR MESSAGE:', err.message)
    return res.redirect(`/admin/users/${req.params.id}/edit`)
  }
})
app.post('/refund/void', requireLogin, requirePerm('canRefundInvoice'), async (req, res) => {
  try {
    const orderId = String(req.body.orderId || '').trim()
    const reason = String(req.body.reason || '').trim()

    if (!orderId) {
      return res.render('refund', {
        title: 'Void / Refund',
        message: 'Invalid order',
        inv: '',
        found: null,
        invoice: null,
        user: req.session.user,
        currentUser: req.session.user
      })
    }

    // 🔥 Directly void using orderId (NO need to search again)
    const saleResponse = await axios.get(`${SALON_API_BASE}/pos/sales/${orderId}`, {
      headers: {
        Authorization: `Bearer ${req.session.user.token}`
      }
    })

    const existingSale = saleResponse.data?.sale || saleResponse.data?.data || saleResponse.data || null

    await axios.post(
      `${SALON_API_BASE}/pos/sales/${orderId}/void`,
      { reason },
      {
        headers: {
          Authorization: `Bearer ${req.session.user.token}`
        }
      }
    )

    const printableSale = existingSale
      ? {
          ...existingSale,
          status: 'VOIDED',
          voidedAt: new Date().toISOString(),
          voidedByName:
            req.session?.user?.username ||
            req.session?.user?.name ||
            req.session?.user?.email ||
            '-'
        }
      : null

    return res.render('refund', {
      title: 'Void / Refund',
      message: 'Invoice voided successfully',
      inv: '',
      found: printableSale,
      invoice: printableSale,
      autoPrintVoid: true,
      voidReason: reason,
      user: req.session.user,
      currentUser: req.session.user
    })
  } catch (err) {
    console.error('VOID ERROR:', err.response?.data || err.message)

    return res.render('refund', {
      title: 'Void / Refund',
      message: JSON.stringify(err.response?.data || err.message),
      inv: '',
      found: null,
      invoice: null,
      user: req.session.user,
      currentUser: req.session.user
    })
  }
})
app.get('/admin/items', requireLogin, requirePerm('canManageItems'), (req, res) => {
  return res.render('items_settings', {
    title: 'Items Settings',
    message: null,
    q: '',
    found: null,
    user: req.session.user,
    currentUser: req.session.user
  });
});


app.get('/admin/logs', requireLogin, requirePerm('canManageSettings'), (req, res) => {
  return res.render('admin_logs', {
    title: 'Audit Logs',
    message: null,
    q: String(req.query.q || ''),
    logs: [],
    found: null,
    user: req.session.user,
    currentUser: req.session.user
  });
});
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/dashboard', requireLogin, (req, res) => {
  return res.redirect('/admin');
});

app.get('/admin', requireLogin, requirePerm('canManageSettings'), (req, res) => {
  return res.render('admin_dashboard', {
    title: 'Admin Dashboard',
    message: null,
    q: '',
    found: null,
    user: req.session.user,
    currentUser: req.session.user
  });
});
app.get('/refund', requireLogin, requirePerm('canRefundInvoice'), async (req, res) => {
  try {
    const inv = String(req.query.invoice || '').trim()

    let found = null

    if (inv) {
      const response = await axios.get(`${SALON_API_BASE}/pos/sales/by-invoice/${encodeURIComponent(inv)}`, {
        headers: {
          Authorization: `Bearer ${req.session.user.token}`
        }
      })

      found = response.data?.sale || response.data?.data || response.data || null
    }

  return res.render('refund', {
  title: 'Void / Refund',
  message: null,
  inv: String(req.query.invoice || '').trim(),
  found,
  invoice: found,
  user: req.session.user,
  currentUser: req.session.user
})
  } catch (err) {
    console.error('REFUND SEARCH ERROR:', err.response?.data || err.message)

    return res.render('refund', {
      title: 'Void / Refund',
      message: 'Failed to search invoice',
      inv: String(req.query.invoice || ''),
      found: null,
      invoice: null,
      user: req.session.user,
      currentUser: req.session.user
    })
  }
})

// ----------------------
// Items API (proxy to salon backend)
// ----------------------
app.get('/api/items', requireLogin, requirePerm('canManageItems'), async (req, res) => {
  try {
    const qs = req.query.all === '1' ? '?all=1' : '';
    const result = await salonRequest(req, `/pos/items${qs}`, { method: 'GET' });

    if (!result.ok) {
      return res.status(result.status).json({
        message: result.data?.message || result.data?.error || 'Failed to load items'
      });
    }

    return res.json(result.data);
  } catch (err) {
    console.error('GET /api/items proxy error:', err);
    return res.status(500).json({ message: 'Failed to load items' });
  }
});

app.post('/api/items', requireLogin, requirePerm('canManageItems'), async (req, res) => {
  try {
    const result = await salonRequest(req, '/pos/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    });

    if (!result.ok) {
      return res.status(result.status).json({
        message: result.data?.message || result.data?.error || 'Failed to create item'
      });
    }

    clearSalonItemCache();
    return res.json(result.data);
  } catch (err) {
    console.error('POST /api/items proxy error:', err);
    return res.status(500).json({ message: 'Failed to create item' });
  }
});

app.put('/api/items/:id', requireLogin, requirePerm('canManageItems'), async (req, res) => {
  try {
    const result = await salonRequest(req, `/pos/items/${req.params.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    });

    if (!result.ok) {
      return res.status(result.status).json({
        message: result.data?.message || result.data?.error || 'Failed to update item'
      });
    }

    clearSalonItemCache();
    return res.json(result.data);
  } catch (err) {
    console.error('PUT /api/items/:id proxy error:', err);
    return res.status(500).json({ message: 'Failed to update item' });
  }
});

// ----------------------
// POS page
// ----------------------
app.get('/pos', requireLogin, requirePerm('canAccessPOS'), async (req, res) => {
  try {
    const currentUser = getCurrentUser(req, res)
    const [items, invoiceResult] = await Promise.all([
      fetchSalonItems(req),
      salonRequest(req, '/pos/next-invoice')
    ])

    const sessionData = getSessionDay(req)
    const sessionOpen = isSessionDayOpen(req)

    const nextInvoiceNumber = invoiceResult.ok
      ? Number(invoiceResult.data?.nextInvoiceNumber || 1)
      : 1

    res.set('Cache-Control', 'no-store')

    return res.render('pos', {
      user: currentUser,
      items,
      nextInvoice: nextInvoiceNumber,
      sessionOpen,
      sessionData
    })
  } catch (err) {
    console.error('GET /pos error:', err)
    return res.status(500).send('Failed to load POS')
  }
})

// ----------------------
// POS APIs used by cabine pos.ejs
// ----------------------
app.post('/api/orders', requireLogin, requirePerm('canConfirmOrder'), async (req, res) => {
  try {
    const { items, discountAmount = 0 } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'no items' });
    }

    const mappedItems = items.map((it) => {
      const itemId = String(it.id || '').trim();
      const itemType = String(it.type || '').trim().toLowerCase();

      if (!itemId) {
        throw new Error(`Item id is missing for ${it.category || 'item'}`);
      }

      if (!['service', 'product'].includes(itemType)) {
        throw new Error(`Invalid item type for ${it.category || 'item'}`);
      }

      return {
        id: itemId,
        type: itemType,
        qty: Math.max(1, parseInt(it.qty, 10) || 1),
        unitPriceCents: Math.max(0, Math.round(Number(it.unitPriceCents || 0)))
      };
    });

    const result = await salonRequest(req, '/pos/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: mappedItems,
        autoConfirm: true,
        discount: Number(discountAmount || 0)
      })
    });

    if (!result.ok) {
      return res.status(result.status).json({
        error:
          result.data?.message ||
          result.data?.error ||
          'failed to create order'
      });
    }
    const sale =
      result.data?.sale ||
      result.data?.data ||
      result.data;

    const saleId = sale?.id || result.data?.id;

    if (!saleId) {
      console.error('CREATE ORDER: backend response missing sale id', result.data);
      return res.status(500).json({ error: 'Backend sale id missing from create response' });
    }

    return res.json({
      ok: true,
      orderId: saleId,
      saleId,
      id: saleId,
      sale,
      ...sale
    });
  } catch (e) {
    console.error('POST /api/orders error:', e);
    return res.status(500).json({
      error: e.message || 'failed to create order'
    });
  }
});

app.post('/api/orders/:orderId/confirm', requireLogin, requirePerm('canConfirmOrder'), async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();

    if (!orderId) {
      return res.status(400).json({ error: 'Invalid order id' });
    }

    const result = await salonRequest(
      req,
      `/pos/sales/${orderId}/confirm`,
      {
        method: 'POST'
      }
    );

    if (!result.ok) {
      console.error('CONFIRM failed response:', result.status, result.data);
      return res.status(result.status).json({
        error:
          result.data?.message ||
          result.data?.error ||
          'Confirm failed'
      });
    }

    return res.json({
      ok: true,
      ...(result.data || {})
    });
  } catch (err) {
    console.error('confirm order error:', err.response?.data || err.message || err);
    return res.status(500).json({
      error: err.response?.data?.message || err.response?.data?.error || 'Confirm failed'
    });
  }
});


app.post('/api/orders/:orderId/void', requireLogin, requirePerm('canVoidOrder'), async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();

    if (!orderId) {
      return res.status(400).json({ error: 'Invalid order id' });
    }

  const result = await salonRequest(req, `/pos/sales/${orderId}/void`, {
  method: 'POST'
});

    if (!result.ok) {
      return res.status(result.status).json({
        error:
          result.data?.message ||
          result.data?.error ||
          'Void failed'
      });
    }

    return res.json(result.data);
  } catch (err) {
    console.error('VOID ORDER ERROR:', err);
    return res.status(500).json({ error: 'Void failed' });
  }
});

app.get('/api/stats/my-daily-sales', requireLogin, requirePerm('canAccessPOS'), async (req, res) => {
  try {
    const result = await salonRequest(req, '/pos/sales/today');

    if (!result.ok) {
      return res.status(result.status).json({
        error:
          result.data?.message ||
          result.data?.error ||
          'Failed to load daily sales'
      });
    }

    const sales = extractSalesArray(result.data);
    const confirmedSales = sales.filter((x) => x.status === 'CONFIRMED');
    const revenue = Number(result.data?.totalCents || 0) / 100;

    return res.json({
      revenue,
      invoices: confirmedSales.length,
      breakdown: []
    });
  } catch (err) {
    console.error('GET /api/stats/my-daily-sales error:', err);
    return res.status(500).json({ error: 'Failed to load daily sales' });
  }
});

// ----------------------
// Reports
// ----------------------
app.get('/reports/daily', requireLogin, requirePerm('canViewDailyReport'), async (req, res) => {
  try {
    const qs = buildQueryString(req.query);
    const result = await salonRequest(req, `/reports/daily${qs}`);

    if (!result.ok) {
      return res.status(result.status).send(
        result.data?.message || result.data?.error || 'Failed to load daily report'
      );
    }

    const sales = extractSalesArray(result.data);
    const totalCents = Number(result.data?.totalCents || 0);

    return res.send(renderSimpleReportPage('Daily Report', sales, totalCents));
  } catch (err) {
    console.error('GET /reports/daily error:', err);
    return res.status(500).send('Failed to load daily report');
  }
});

app.get('/reports/monthly', requireLogin, requirePerm('canViewMonthlyReport'), async (req, res) => {
  try {
    const qs = buildQueryString(req.query);
    const result = await salonRequest(req, `/reports/monthly${qs}`);

    if (!result.ok) {
      return res.status(result.status).send(
        result.data?.message || result.data?.error || 'Failed to load monthly report'
      );
    }

    const sales = extractSalesArray(result.data);
    const totalCents = Number(result.data?.totalCents || 0);

    return res.send(renderSimpleReportPage('Monthly Report', sales, totalCents));
  } catch (err) {
    console.error('GET /reports/monthly error:', err);
    return res.status(500).send('Failed to load monthly report');
  }
});

app.get('/reports/voided', requireLogin, requirePerm('canViewVoidedReport'), async (req, res) => {
  try {
    const qs = buildQueryString(req.query);
    const result = await salonRequest(req, `/reports/voided${qs}`);

    if (!result.ok) {
      return res.status(result.status).send(
        result.data?.message || result.data?.error || 'Failed to load voided report'
      );
    }

    const sales = extractSalesArray(result.data);
    const totalCents = Number(result.data?.totalCents || 0);

    return res.send(renderSimpleReportPage('Voided Report', sales, totalCents));
  } catch (err) {
    console.error('GET /reports/voided error:', err);
    return res.status(500).send('Failed to load voided report');
  }
});

app.get('/reports/:period', requireLogin, (req, res) => {
  const p = req.params.period;
  if (p === 'daily') return res.redirect('/reports/daily');
  if (p === 'monthly') return res.redirect('/reports/monthly');
  if (p === 'voided') return res.redirect('/reports/voided');
  return res.redirect('/reports/daily');
});

app.get('/reports', requireLogin, (req, res) => {
  return res.redirect('/reports/daily');
});

// ----------------------
// Open / close day session
// ----------------------
app.post('/api/session/open', requireLogin, requirePerm('canAccessPOS'), async (req, res) => {
  try {
    const sessionKey = getSessionOpenKey(req, res);
    const existing = getSessionDay(req);

    if (existing && existing.isOpen) {
      return res.status(400).json({ error: 'Day is already open' });
    }

    req.session.posDay = {
      key: sessionKey,
      isOpen: true,
      openedAt: new Date().toISOString()
    };

    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve(null)));
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/session/open error:', err);
    return res.status(500).json({ error: 'Failed to open day' });
  }
});

app.post('/api/session/close', requireLogin, requirePerm('canAccessPOS'), async (req, res) => {
  try {
    const sessionKey = getSessionOpenKey(req, res);
    const existing = getSessionDay(req);

    if (!existing || !existing.isOpen) {
      return res.status(400).json({ error: 'Day is already closed' });
    }

    const closedAt = new Date();

    req.session.posDay = {
      ...existing,
      key: sessionKey,
      isOpen: false,
      closedAt: closedAt.toISOString()
    };

    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve(null)));
    });

    return res.json({
      ok: true,
      openedAt: existing.openedAt,
      closedAt
    });
  } catch (err) {
    console.error('POST /api/session/close error:', err);
    return res.status(500).json({ error: 'Failed to close day' });
  }
});

// ----------------------
// Server startup
// ----------------------
app.listen(port, '0.0.0.0', () => {
  console.log(`Cabine thin-frontend server running on port ${port}`);
  console.log(`Using salon backend: ${SALON_API_BASE}`);
});
