const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 3000;

const ROOT = __dirname;

const DATA_DIR = path.join(ROOT, "data");
const ORIGINALS_DIR = path.join(
  ROOT,
  "storage",
  "originals"
);
const WATERMARK_DIR = path.join(
  ROOT,
  "storage",
  "watermarked"
);
const TEMP_DIR = path.join(
  ROOT,
  "temp"
);

/*
|--------------------------------------------------------------------------
| CRIAR PASTAS
|--------------------------------------------------------------------------
*/

[
  DATA_DIR,
  ORIGINALS_DIR,
  WATERMARK_DIR,
  TEMP_DIR
].forEach((dir) => {
  fs.mkdirSync(dir, {
    recursive: true
  });
});

/*
|--------------------------------------------------------------------------
| CONFIGURAÇÃO
|--------------------------------------------------------------------------
*/

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(
    path.join(ROOT, "public")
  )
);

/*
|--------------------------------------------------------------------------
| DADOS TEMPORÁRIOS
|--------------------------------------------------------------------------
|
| Nesta primeira versão os dados ficam
| na memória enquanto o servidor estiver ligado.
|
*/

const galleries = new Map();

const photos = new Map();

const selections = new Map();

const sessions = new Set();

/*
|--------------------------------------------------------------------------
| GERAR ID
|--------------------------------------------------------------------------
*/

function createId() {
  return crypto.randomUUID();
}

/*
|--------------------------------------------------------------------------
| AUTENTICAÇÃO DO ADMIN
|--------------------------------------------------------------------------
*/

function requireAdmin(
  req,
  res,
  next
) {

  const authorization =
    req.headers.authorization;

  const token =
    authorization
      ?.replace("Bearer ", "");

  if (
    !token ||
    !sessions.has(token)
  ) {

    return res.status(401).json({
      error:
        "Não autorizado."
    });

  }

  next();
}

/*
|--------------------------------------------------------------------------
| UPLOAD
|--------------------------------------------------------------------------
*/

const upload = multer({

  dest: TEMP_DIR,

  limits: {
    fileSize:
      30 * 1024 * 1024
  },

  fileFilter: (
    req,
    file,
    callback
  ) => {

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (
      !allowedTypes.includes(
        file.mimetype
      )
    ) {

      return callback(
        new Error(
          "Formato de imagem não permitido."
        )
      );

    }

    callback(null, true);

  }

});

/*
|--------------------------------------------------------------------------
| MARCA D'ÁGUA
|--------------------------------------------------------------------------
*/

function createWatermark(
  width,
  height
) {

  const fontSize =
    Math.max(
      28,
      Math.round(width / 20)
    );

  return `
<svg
  width="${width}"
  height="${height}"
  xmlns="http://www.w3.org/2000/svg"
>

  <style>

    .watermark {
      fill: white;
      opacity: 0.35;
      font-size: ${fontSize}px;
      font-family: Arial, sans-serif;
      font-weight: bold;
    }

  </style>

  <text
    x="${width / 2}"
    y="${height / 2}"
    text-anchor="middle"
    dominant-baseline="middle"
    transform="
      rotate(
        -25
        ${width / 2}
        ${height / 2}
      )
    "
    class="watermark"
  >
    MINHA MARCA
  </text>

</svg>
`;

}

/*
|--------------------------------------------------------------------------
| CRIAR FOTO COM MARCA D'ÁGUA
|--------------------------------------------------------------------------
*/

async function createWatermarkedPhoto(
  input,
  output
) {

  const image =
    sharp(input);

  const metadata =
    await image.metadata();

  const width =
    metadata.width || 1600;

  const height =
    metadata.height || 1000;

  const watermark =
    Buffer.from(
      createWatermark(
        width,
        height
      )
    );

  await sharp(input)
    .composite([
      {
        input: watermark,
        gravity: "center"
      }
    ])
    .jpeg({
      quality: 85
    })
    .toFile(output);

}

/*
|--------------------------------------------------------------------------
| LOGIN
|--------------------------------------------------------------------------
*/

app.post(
  "/api/login",
  (req, res) => {

    const password =
      req.body.password;

    const adminPassword =
      process.env.ADMIN_PASSWORD ||
      "123456";

    if (
      !password ||
      password !== adminPassword
    ) {

      return res.status(401).json({
        error:
          "Senha incorreta."
      });

    }

    const token =
      crypto
        .randomBytes(32)
        .toString("hex");

    sessions.add(token);

    res.json({
      token
    });

  }
);

/*
|--------------------------------------------------------------------------
| LISTAR GALERIAS
|--------------------------------------------------------------------------
*/

app.get(
  "/api/galleries",
  requireAdmin,
  (req, res) => {

    res.json(
      Array.from(
        galleries.values()
      )
    );

  }
);

/*
|--------------------------------------------------------------------------
| CRIAR GALERIA
|--------------------------------------------------------------------------
*/

app.post(
  "/api/galleries",
  requireAdmin,
  (req, res) => {

    const name =
      req.body.name;

    if (
      !name ||
      !name.trim()
    ) {

      return res.status(400).json({
        error:
          "Nome da galeria obrigatório."
      });

    }

    const gallery = {

      id: createId(),

      name: name.trim(),

      createdAt:
        new Date().toISOString()

    };

    galleries.set(
      gallery.id,
      gallery
    );

    res.json(
      gallery
    );

  }
);

/*
|--------------------------------------------------------------------------
| VISUALIZAR GALERIA
|--------------------------------------------------------------------------
*/

app.get(
  "/api/gallery/:id",
  (req, res) => {

    const gallery =
      galleries.get(
        req.params.id
      );

    if (!gallery) {

      return res.status(404).json({
        error:
          "Galeria não encontrada."
      });

    }

    const galleryPhotos =
      Array.from(
        photos.values()
      )
      .filter(
        (photo) =>
          photo.galleryId ===
          gallery.id
      )
      .map(
        (photo) => ({

          id: photo.id,

          filename:
            photo.filename,

          url:
            `/images/${photo.filename}`

        })
      );

    res.json({

      gallery,

      photos:
        galleryPhotos

    });

  }
);

/*
|--------------------------------------------------------------------------
| UPLOAD DE FOTOS
|--------------------------------------------------------------------------
*/

app.post(
  "/api/galleries/:galleryId/photos",
  requireAdmin,
  upload.array(
    "photos",
    100
  ),
  async (req, res) => {

    const gallery =
      galleries.get(
        req.params.galleryId
      );

    if (!gallery) {

      return res.status(404).json({
        error:
          "Galeria não encontrada."
      });

    }

    if (
      !req.files ||
      req.files.length === 0
    ) {

      return res.status(400).json({
        error:
          "Nenhuma foto enviada."
      });

    }

    const created = [];

    try {

      for (
        const file of req.files
      ) {

        const photoId =
          createId();

        const filename =
          `${photoId}.jpg`;

        const originalPath =
          path.join(
            ORIGINALS_DIR,
            filename
          );

        const watermarkedPath =
          path.join(
            WATERMARK_DIR,
            filename
          );

        /*
        | Salvar original
        */

        await sharp(
          file.path
        )
        .jpeg({
          quality: 95
        })
        .toFile(
          originalPath
        );

        /*
        | Criar versão com marca d'água
        */

        await createWatermarkedPhoto(
          file.path,
          watermarkedPath
        );

        /*
        | Apagar arquivo temporário
        */

        fs.unlinkSync(
          file.path
        );

        const photo = {

          id: photoId,

          galleryId:
            gallery.id,

          filename,

          createdAt:
            new Date().toISOString()

        };

        photos.set(
          photoId,
          photo
        );

        created.push(
          photo
        );

      }

      res.json({

        message:
          `${created.length} foto(s) enviada(s).`,

        photos:
          created

      });

    } catch (error) {

      console.error(
        "Erro ao processar fotos:",
        error
      );

      res.status(500).json({
        error:
          "Erro ao processar as fotos."
      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| SERVIR FOTOS COM MARCA D'ÁGUA
|--------------------------------------------------------------------------
*/

app.use(
  "/images",
  express.static(
    WATERMARK_DIR
  )
);

/*
|--------------------------------------------------------------------------
| SELECIONAR FOTO
|--------------------------------------------------------------------------
*/

app.post(
  "/api/photos/:photoId/select",
  (req, res) => {

    const photo =
      photos.get(
        req.params.photoId
      );

    if (!photo) {

      return res.status(404).json({
        error:
          "Foto não encontrada."
      });

    }

    const clientId =
      req.body.clientId ||
      "anonymous";

    const key =
      `${clientId}:${photo.id}`;

    const current =
      selections.get(
        key
      ) || false;

    const selected =
      !current;

    selections.set(
      key,
      selected
    );

    res.json({
      selected
    });

  }
);

/*
|--------------------------------------------------------------------------
| LISTAR FOTOS SELECIONADAS
|--------------------------------------------------------------------------
*/

app.get(
  "/api/selections/:galleryId",
  requireAdmin,
  (req, res) => {

    const result = [];

    for (
      const [
        key,
        selected
      ]
      of selections.entries()
    ) {

      if (!selected) {
        continue;
      }

      const parts =
        key.split(":");

      const photoId =
        parts[1];

      const photo =
        photos.get(
          photoId
        );

      if (
        photo &&
        photo.galleryId ===
          req.params.galleryId
      ) {

        result.push(
          photo
        );

      }

    }

    res.json(
      result
    );

  }
);

/*
|--------------------------------------------------------------------------
| DOWNLOAD DA FOTO COM MARCA D'ÁGUA
|--------------------------------------------------------------------------
*/

app.get(
  "/api/photos/:photoId/download",
  (req, res) => {

    const photo =
      photos.get(
        req.params.photoId
      );

    if (!photo) {

      return res.status(404).send(
        "Foto não encontrada."
      );

    }

    const file =
      path.join(
        WATERMARK_DIR,
        photo.filename
      );

    if (!fs.existsSync(file)) {

      return res.status(404).send(
        "Arquivo não encontrado."
      );

    }

    res.download(
      file
    );

  }
);

/*
|--------------------------------------------------------------------------
| PÁGINA INICIAL
|--------------------------------------------------------------------------
*/

app.get(
  "/",
  (req, res) => {

    res.sendFile(
      path.join(
        ROOT,
        "public",
        "index.html"
      )
    );

  }
);

/*
|--------------------------------------------------------------------------
| PAINEL ADMINISTRATIVO
|--------------------------------------------------------------------------
*/

app.get(
  "/admin",
  (req, res) => {

    res.sendFile(
      path.join(
        ROOT,
        "public",
        "admin.html"
      )
    );

  }
);

/*
|--------------------------------------------------------------------------
| GALERIA DO CLIENTE
|--------------------------------------------------------------------------
*/

app.get(
  "/galeria/:id",
  (req, res) => {

    res.sendFile(
      path.join(
        ROOT,
        "public",
        "gallery.html"
      )
    );

  }
);

/*
|--------------------------------------------------------------------------
| TRATAMENTO DE ERROS
|--------------------------------------------------------------------------
*/

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      error
    );

    res.status(500).json({

      error:
        error.message ||
        "Erro interno do servidor."

    });

  }
);

/*
|--------------------------------------------------------------------------
| INICIAR SERVIDOR
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  () => {

    console.log("");

    console.log(
      "================================"
    );

    console.log(
      "         FOTO GALERIA"
    );

    console.log(
      "================================"
    );

    console.log("");

    console.log(
      `Site: http://localhost:${PORT}`
    );

    console.log(
      `Admin: http://localhost:${PORT}/admin`
    );

    console.log("");

  }
);
