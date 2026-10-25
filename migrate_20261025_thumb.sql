-- 2026-10-25 首页缩略图
-- 列表以前直接拿 orig/* 原图当缩略图（每张 400–480 KB，8 张 ≈ 3.2 MB）。
-- 现在上传时客户端顺带生成一张 320px 小图，存成 thumb/*，列表用小的、点进去看原图。
-- submissions.thumb_key：这份作业列表缩略图（单页作业指向第一页缩略图）。
-- submission_pages.thumb_key：每页自己的缩略图（多页作业加页时也会生成）。
ALTER TABLE submissions ADD COLUMN thumb_key TEXT;
ALTER TABLE submission_pages ADD COLUMN thumb_key TEXT;
