require("dotenv").config();

const express = require("express");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.get("/", (req, res) => {
  res.send(`
    <h1>🎰 Hmara Casino</h1>
    <p>Connecte-toi pour commencer à jouer !</p>
    <a href="/auth/discord">Se connecter avec Discord</a>
  `);
});

app.get("/auth/discord", (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_CALLBACK_URL,
    response_type: "code",
    scope: "identify"
  });

  res.redirect(
    "https://discord.com/oauth2/authorize?" + params.toString()
  );
});

app.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).send("Connexion Discord annulée ou code manquant.");
  }

  try {
    const tokenResponse = await fetch(
      "https://discord.com/api/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: process.env.DISCORD_CALLBACK_URL
        })
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(400).send("Échec de la connexion Discord.");
    }

    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`
      }
    });

    const user = await userResponse.json();

    if (!userResponse.ok) {
      return res.status(400).send("Impossible de récupérer ton profil Discord.");
    }

    req.session.user = {
      id: user.id,
      username: user.global_name || user.username,
      avatar: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        : null
    };

    res.redirect("/me");
  } catch (error) {
    console.error("Erreur OAuth Discord :", error.message);
    res.status(500).send("Erreur pendant la connexion Discord.");
  }
});

app.get("/me", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/");
  }

  res.send(`
    <h1>Bienvenue sur Hmara Casino !</h1>
    <p>Connecté en tant que ${escapeHtml(req.session.user.username)}</p>
    <a href="/logout">Se déconnecter</a>
  `);
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Hmara Casino écoute sur le port ${PORT}`);
});
