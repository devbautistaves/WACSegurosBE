const jwt = require("jsonwebtoken")

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"]

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token no proporcionado o inválido" })
  }

  const token = authHeader.split(" ")[1]

  if (!process.env.JWT_SECRET) {
    console.error("⚠️ JWT_SECRET no está definido en el .env")
    return res.status(500).json({ error: "Error en el servidor" })
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Token inválido o expirado" })

    req.user = decoded
    next()
  })
}

module.exports = authenticateToken