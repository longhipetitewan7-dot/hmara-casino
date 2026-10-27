
require("dotenv").config();

const express = require("express");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = "https://hmara-casino-eq5f.onrender.com";

app.set("trust proxy", 1);
app.use(express.json());

// Autorise le site du casino à communiquer avec le serveur
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", FRONTEND_URL);
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// Session de connexion
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

// Page de vérification du serveur
app.get("/", (req, res) => {
  res.send("🎰 Hmara Casino — serveur en ligne !");
});

// Démarrer la connexion Discord
app.get("/auth/discord", (req, res) => {
  if (
    !process.env.DISCORD_CLIENT_ID ||
    !process.env.DISCORD_CLIENT_SECRET ||
    !process.env.DISCORD_CALLBACK_URL
  ) {
    return res.status(500).send("La configuration Discord est incomplète.");
  }

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_CALLBACK_URL,
    response_type: "code",
    scope: "identify"
  });

  res.redirect("https://discord.com/oauth2/authorize?" + params.toString());
});

// Retour de Discord après la connexion
app.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).send("Connexion Discord annulée.");
  }

  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: process.env.DISCORD_CALLBACK_URL
      })
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("Erreur lors de l'échange du code Discord.");
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

    req.session.save((err) => {
      if (err) {
        console.error("Erreur de session :", err.message);
        return res.status(500).send("Impossible de sauvegarder la connexion.");
      }

      res.redirect(FRONTEND_URL + "/");
    });
  } catch (error) {
    console.error("Erreur OAuth Discord :", error.message);
    res.status(500).send("Erreur pendant la connexion Discord.");
  }
});

// Vérifier si le joueur est connecté
app.get("/api/me", (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ loggedIn: false });
  }

  res.json({
    loggedIn: true,
    user: req.session.user
  });
});

// Déconnexion
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    res.clearCookie("connect.sid", {
      httpOnly: true,
      secure: true,
      sameSite: "none"
    });

    if (err) {
      return res.status(500).send("Erreur pendant la déconnexion.");
    }

    res.redirect(FRONTEND_URL + "/");
  });
});

// Vérifier que le serveur fonctionne
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Hmara Casino écoute sur le port ${PORT}`);
});
