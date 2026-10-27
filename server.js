
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const cors = require("cors");
const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const app = express();
const PORT = process.env.PORT || 3000;

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "https://hmara-casino-eq5f.onrender.com";

const BACKEND_URL =
  process.env.BACKEND_URL ||
  "https://hmara-casinofr.onrender.com";

const CALLBACK_URL =
  process.env.DISCORD_CALLBACK_URL ||
  `${BACKEND_URL}/auth/discord/callback`;

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET || !SESSION_SECRET) {
  console.error("Variables Discord ou SESSION_SECRET manquantes.");
  process.exit(1);
}

app.set("trust proxy", 1);

app.use(cors({
  origin: FRONTEND_URL,
  credentials: true
}));

app.use(express.json({ limit: "20kb" }));

// SQLite : configure DB_PATH dans Render pour utiliser le disque persistant.
const dbPath = process.env.DB_PATH || "./data/hmara.sqlite";
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    avatar TEXT,
    coins INTEGER NOT NULL DEFAULT 10000,
    wins INTEGER NOT NULL DEFAULT 0,
    played INTEGER NOT NULL DEFAULT 0,
    last_bonus INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    details TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
`);

db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());

const getUser = db.prepare("SELECT * FROM users WHERE id = ?");
const updateBalance = db.prepare(
  "UPDATE users SET coins = ?, wins = ?, played = ? WHERE id = ?"
);

function logTransaction(userId, type, amount, details = {}) {
  db.prepare(`
    INSERT INTO transactions (user_id, type, amount, details, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, type, amount, JSON.stringify(details), Date.now());
}

// Stockage persistant des sessions Express dans SQLite.
class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare(
        "SELECT sess, expires FROM sessions WHERE sid = ?"
      ).get(sid);

      if (!row) return callback(null, null);

      if (row.expires < Date.now()) {
        db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
        return callback(null, null);
      }

      callback(null, JSON.parse(row.sess));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const cookieExpiry = sess.cookie?.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;

      db.prepare(`
        INSERT INTO sessions (sid, sess, expires)
        VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET
          sess = excluded.sess,
          expires = excluded.expires
      `).run(sid, JSON.stringify(sess), cookieExpiry);

      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      const expiry = sess.cookie?.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;

      db.prepare(
        "UPDATE sessions SET expires = ? WHERE sid = ?"
      ).run(expiry, sid);

      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

app.use(session({
  name: "hmara.sid",
  secret: SESSION_SECRET,
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Connexion Discord requise."
    });
  }

  next();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    coins: user.coins,
    wins: user.wins,
    played: user.played,
    score: user.coins + user.wins * 300
  };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Vérification de l'état de service.
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "hmara-casino-api" });
});

// Connexion Discord OAuth2.
app.get("/auth/discord", (req, res, next) => {
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;

  req.session.save(error => {
    if (error) return next(error);

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK_URL,
      response_type: "code",
      scope: "identify",
      state
    });

    res.redirect(
      "https://discord.com/oauth2/authorize?" + params.toString()
    );
  });
});

app.get("/auth/discord/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(FRONTEND_URL + "/?discord=cancelled");
    }

    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      !req.session.oauthState ||
      state !== req.session.oauthState
    ) {
      return res.status(400).send("État OAuth invalide. Réessaie la connexion.");
    }

    delete req.session.oauthState;

    const tokenResponse = await fetch(
      "https://discord.com/api/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: CALLBACK_URL
        })
      }
    );

    const tokens = await tokenResponse.json();

    if (!tokenResponse.ok || !tokens.access_token) {
      console.error("Échec échange OAuth:", tokens.error || tokenResponse.status);
      return res.status(502).send("La connexion Discord a échoué.");
    }

    const discordResponse = await fetch(
      "https://discord.com/api/users/@me",
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`
        }
      }
    );

    const discordUser = await discordResponse.json();

    if (!discordResponse.ok || !discordUser.id) {
      return res.status(502).send("Impossible de récupérer le profil Discord.");
    }

    const avatar = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=128`
      : null;

    const now = Date.now();

    db.prepare(`
      INSERT INTO users (id, username, avatar, coins, wins, played, last_bonus, created_at)
      VALUES (?, ?, ?, 10000, 0, 0, 0, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        avatar = excluded.avatar
    `).run(discordUser.id, discordUser.username, avatar, now);

    req.session.regenerate(error => {
      if (error) {
        console.error(error);
        return res.status(500).send("Impossible de créer la session.");
      }

      req.session.userId = discordUser.id;

      req.session.save(error => {
        if (error) {
          console.error(error);
          return res.status(500).send("Impossible d'enregistrer la session.");
        }

        res.redirect(FRONTEND_URL + "/?discord=connected");
      });
    });
  } catch (error) {
    console.error("OAuth error:", error);
    res.status(500).send("Erreur lors de la connexion Discord.");
  }
});

app.get("/api/me", (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }

  const user = getUser.get(req.session.userId);

  if (!user) {
    return res.json({ user: null });
  }

  res.json({ user: publicUser(user) });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(error => {
    if (error) return res.status(500).json({ error: "Déconnexion impossible." });

    res.clearCookie("hmara.sid", {
      httpOnly: true,
      secure: true,
      sameSite: "none"
    });

    res.json({ ok: true });
  });
});

// Classement commun à tous les membres connectés.
app.get("/api/leaderboard", (req, res) => {
  const users = db.prepare(`
    SELECT id, username, avatar, coins, wins, played
    FROM users
    ORDER BY coins + wins * 300 DESC, wins DESC
    LIMIT 100
  `).all();

  res.json({
    players: users.map(user => ({
      ...publicUser(user),
      name: user.username
    }))
  });
});

// Les jeux sont calculés côté serveur : le navigateur ne choisit pas le gain.
app.post("/api/game", requireLogin, (req, res) => {
  const game = req.body?.game;
  const bet = req.body?.bet;

  const allowedGames = ["slots", "roulette", "dice", "coin", "blackjack"];

  if (!allowedGames.includes(game)) {
    return res.status(400).json({ error: "Jeu inconnu." });
  }

  if (!Number.isSafeInteger(bet) || bet < 1 || bet > 1000000) {
    return res.status(400).json({ error: "Mise invalide." });
  }

  const user = getUser.get(req.session.userId);

  if (!user || user.coins < bet) {
    return res.status(400).json({ error: "Solde insuffisant." });
  }

  let gain = 0;
  let won = false;
  let message = "";
  const result = {};

  if (game === "slots") {
    const symbols = ["🍒", "🍋", "💎", "7️⃣", "🔔", "🍀"];
    result.symbols = [
      symbols[randomInt(0, symbols.length - 1)],
      symbols[randomInt(0, symbols.length - 1)],
      symbols[randomInt(0, symbols.length - 1)]
    ];

    if (result.symbols[0] === result.symbols[1] &&
        result.symbols[1] === result.symbols[2]) {
      gain = bet * 12;
      message = `JACKPOT TRIPLE ! +${gain} jetons`;
    } else if (new Set(result.symbols).size < 3) {
      gain = Math.round(bet * 2.5);
      message = `Belle combinaison ! +${gain} jetons`;
    } else {
      message = "Pas de combinaison cette fois.";
    }
  }

  if (game === "roulette") {
    result.number = randomInt(0, 36);

    if (result.number === 0) {
      gain = bet * 8;
      message = `ZÉRO VERT ! +${gain} jetons`;
    } else if (result.number % 2 === 0) {
      gain = Math.round(bet * 1.8);
      message = `NUMÉRO ${result.number} : +${gain} jetons`;
    } else {
      message = `NUMÉRO ${result.number} : pas de gain.`;
    }
  }

  if (game === "dice") {
    result.dice = [randomInt(1, 6), randomInt(1, 6)];
    result.total = result.dice[0] + result.dice[1];

    if (result.total >= 9) {
      gain = bet * 3;
      message = `Total ${result.total} : +${gain} jetons`;
    } else {
      message = `Total ${result.total} : réessaie !`;
    }
  }

  if (game === "coin") {
    result.side = Math.random() < 0.5 ? "PILE" : "FACE";
    result.won = result.side === "PILE";

    if (result.won) {
      gain = Math.round(bet * 1.8);
      message = `PILE ! +${gain} jetons`;
    } else {
      message = "FACE : pas de gain cette fois.";
    }
  }

  if (game === "blackjack") {
    result.player = [randomInt(2, 11), randomInt(2, 11)];
    result.dealer = [randomInt(2, 11), randomInt(2, 11)];

    const playerTotal = result.player.reduce((a, b) => a + b, 0);
    const dealerTotal = result.dealer.reduce((a, b) => a + b, 0);

    if (playerTotal > dealerTotal) {
      gain = bet * 2;
      message = `Vous remportez la main : +${gain} jetons`;
    } else if (playerTotal === dealerTotal) {
      gain = bet;
      message = "Égalité : mise rendue.";
    } else {
      message = "Le croupier remporte cette main.";
    }

    result.playerTotal = playerTotal;
    result.dealerTotal = dealerTotal;
  }

  if (!Number.isSafeInteger(gain)) {
    return res.status(400).json({ error: "Gain invalide." });
  }

  won = gain > bet;

  const newCoins = user.coins - bet + gain;
  const newWins = user.wins + (won ? 1 : 0);
  const newPlayed = user.played + 1;

  const transaction = db.transaction(() => {
    updateBalance.run(newCoins, newWins, newPlayed, user.id);
    logTransaction(user.id, "game", gain - bet, {
      game,
      bet,
      gain,
      result
    });
  });

  transaction();

  res.json({
    ok: true,
    game,
    bet,
    gain,
    won,
    balance: newCoins,
    wins: newWins,
    played: newPlayed,
    message,
    result
  });
});

// Bonus personnel, partagé entre appareils.
app.post("/api/bonus", requireLogin, (req, res) => {
  const user = getUser.get(req.session.userId);
  if (!user) return res.status(404).json({ error: "Profil introuvable." });

  const cooldown = 6 * 60 * 60 * 1000;
  const remaining = cooldown - (Date.now() - user.last_bonus);

  if (remaining > 0) {
    return res.status(400).json({
      error: "Le cadeau n'est pas encore disponible.",
      remaining
    });
  }

  const now = Date.now();
  const coins = user.coins + 500;

  const transaction = db.transaction(() => {
    db.prepare(
      "UPDATE users SET coins = ?, last_bonus = ? WHERE id = ?"
    ).run(coins, now, user.id);

    logTransaction(user.id, "bonus", 500);
  });

  transaction();

  res.json({ ok: true, balance: coins, bonus: 500, lastBonus: now });
});

// Boutique : les articles restent virtuels tant qu'une intégration Discord
// spécifique et des permissions sûres ne sont pas configurées.
const SHOP = {
  "Rôle Kicker": 2000,
  "Ban · 2 min": 5000,
  "Mute · 2 min": 2000,
  "Mute casque": 3000,
  "Rôle VIP": 10000
};

app.post("/api/shop", requireLogin, (req, res) => {
  const name = req.body?.name;
  const cost = SHOP[name];

  if (!cost) {
    return res.status(400).json({ error: "Article inconnu." });
  }

  const user = getUser.get(req.session.userId);

  if (!user || user.coins < cost) {
    return res.status(400).json({ error: "Solde insuffisant." });
  }

  const transaction = db.transaction(() => {
    db.prepare("UPDATE users SET coins = coins - ? WHERE id = ?")
      .run(cost, user.id);

    logTransaction(user.id, "shop", -cost, { name });
  });

  transaction();

  const updated = getUser.get(user.id);

  res.json({
    ok: true,
    item: name,
    cost,
    balance: updated.coins,
    message: "Achat enregistré. Aucun rôle ni sanction Discord appliqué."
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Erreur serveur." });
});

app.listen(PORT, () => {
  console.log(`HMARA API démarrée sur le port ${PORT}`);
});
