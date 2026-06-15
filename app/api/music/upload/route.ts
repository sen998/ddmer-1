import { NextResponse } from "next/server";
import { prisma } from "@/app/lib/prisma";
import { getCurrentUser } from "@/app/lib/auth";
import { uploadFile, getFile, cleanUrlPath, generateFileName } from "@/app/lib/r2";
import * as mm from "music-metadata";

const ALLOWED_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/flac"];
const ALLOWED_EXTENSIONS = [".mp3", ".wav", ".flac"];
const MAX_SIZE = 50 * 1024 * 1024; // 50MB

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, "_").slice(0, 100);
}

export async function POST(request: Request) {
  try {
    const payload = await getCurrentUser(request);
    const userId = parseInt(payload.sub as string);
    if (isNaN(userId)) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.is_admin) {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    }

    const formData = await request.formData();
    const fileField = formData.get("file");
    const title = (formData.get("title") as string) || "";
    const artist = (formData.get("artist") as string) || "";
    const coverFile = formData.get("cover") as File | null;
    const lrcFile = formData.get("lrc") as File | null;
    const sort = formData.get("sort") ? parseInt(formData.get("sort") as string) : 0;

    let musicUrl = "";
    let fileName = "";
    let buffer: Buffer;
    let fileType = "";

    if (typeof fileField === "string") {
      // 客户端已直传到 R2，传入的是 URL
      musicUrl = fileField;
      fileName = decodeURIComponent(musicUrl.split("/").pop() || "");
      const key = cleanUrlPath(musicUrl);
      const fileBuffer = await getFile(key);
      if (!fileBuffer) {
        return NextResponse.json({ error: "无法从 R2 读取音频文件" }, { status: 400 });
      }
      buffer = fileBuffer;
      const ext = fileName.split(".").pop()?.toLowerCase();
      if (ext === "mp3") fileType = "audio/mpeg";
      else if (ext === "wav") fileType = "audio/wav";
      else if (ext === "flac") fileType = "audio/flac";
      else fileType = "audio/mpeg";
    } else if (fileField instanceof File) {
      const file = fileField;
      fileName = file.name;
      if (file.size > MAX_SIZE) {
        return NextResponse.json({ error: "文件大小超过 50MB 限制" }, { status: 400 });
      }
      const ext = ALLOWED_EXTENSIONS.find((e) => fileName.toLowerCase().endsWith(e));
      if (!ext) {
        return NextResponse.json({ error: "不支持的文件格式，仅支持 MP3、WAV、FLAC" }, { status: 400 });
      }
      const bytes = await file.arrayBuffer();
      buffer = Buffer.from(bytes);
      fileType = file.type || "audio/mpeg";
      const safeName = generateFileName(ext.replace(".", ""));
      const musicKey = `uploads/music/${safeName}`;
      musicUrl = await uploadFile(musicKey, bytes, fileType);
    } else {
      return NextResponse.json({ error: "缺少音频文件" }, { status: 400 });
    }

    // 提取音频元数据
    let finalTitle = title;
    let finalArtist = artist;
    let coverUrl = "";
    let lrcText = "";

    try {
      const metadata = await mm.parseBuffer(buffer, { mimeType: file.type || "audio/mpeg" });
      const common = metadata.common;

      if (!finalTitle && common.title) finalTitle = common.title;
      if (!finalArtist) {
        finalArtist = common.artist || common.artists?.join(", ") || "";
      }

      // 提取内嵌封面
      if (common.picture && common.picture.length > 0 && !coverFile) {
        const pic = common.picture[0];
        const picExt = pic.format?.split("/").pop() || "jpg";
        const picName = generateFileName(picExt);
        const picKey = `uploads/${picName}`;
        coverUrl = await uploadFile(picKey, pic.data.buffer, pic.format || "image/jpeg");
      }

      // 提取内嵌歌词
      if (common.lyrics && common.lyrics.length > 0) {
        const first = common.lyrics[0];
        lrcText = typeof first === "string" ? first : first.text || "";
      }
      if (!lrcText && metadata.native) {
        const lyricTagIds = ["LYRICS", "lyrics", "USLT", "SYLT", "©lyr", "WM/Lyrics", "Lyrics"];
        for (const [tagType, tags] of Object.entries(metadata.native)) {
          for (const tag of tags as any[]) {
            if (lyricTagIds.includes(tag.id) && tag.value) {
              const val = typeof tag.value === "string" ? tag.value : tag.value.text || tag.value;
              if (val && typeof val === "string" && val.trim().length > 10) {
                lrcText = val.trim();
                break;
              }
            }
          }
          if (lrcText) break;
        }
      }
      if (!lrcText && common.comment && common.comment.length > 0) {
        for (const c of common.comment) {
          const text = typeof c === "string" ? c : c.text || "";
          if (text && text.includes("[") && text.includes("]")) {
            lrcText = text;
            break;
          }
        }
      }
    } catch (e) {
      console.error("Metadata parse error:", e);
    }

    // 手动上传的封面优先
    if (coverFile) {
      const coverExt = coverFile.name.split(".").pop() || "jpg";
      const coverName = generateFileName(coverExt);
      const coverKey = `uploads/${coverName}`;
      const coverBytes = await coverFile.arrayBuffer();
      coverUrl = await uploadFile(coverKey, coverBytes, coverFile.type);
    }

    // 手动上传的歌词文件优先于内嵌歌词
    let lrcSrc = "";
    if (lrcFile) {
      const lrcExt = lrcFile.name.split(".").pop() || "lrc";
      const lrcName = generateFileName(lrcExt);
      const lrcKey = `uploads/music/${lrcName}`;
      const lrcBytes = await lrcFile.arrayBuffer();
      lrcSrc = await uploadFile(lrcKey, lrcBytes, "text/plain");
      lrcText = new TextDecoder().decode(lrcBytes);
    }

    const music = await prisma.music.create({
      data: {
        title: finalTitle || file.name.replace(ext, ""),
        artist: finalArtist,
        cover: coverUrl,
        src: musicUrl,
        lrc: lrcText,
        lrcSrc: lrcSrc,
        type: "local",
        sort,
      },
    });

    return NextResponse.json({ success: true, music });
  } catch (err: any) {
    if (err.message === "未登录" || err.message === "无效的令牌") {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error("Music upload error:", err);
    return NextResponse.json({ error: "上传失败: " + (err.message || "未知错误"), stack: err?.stack }, { status: 500 });
  }
}