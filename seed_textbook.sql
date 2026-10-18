-- 北师大版（2024 新课标修订版）小学数学四年级上册 · 教材目录
-- 2026 年秋季学期起，小学四、五、六年级数学首次启用依据《义务教育数学课程标准（2022年版）》
-- 修订的新教材（三年三步走：2024秋一/七年级 → 2025秋二、三/八年级 → 2026秋全部年级）。
-- 所以四年级现在用的是 2024 版新教材，单元是「大换血」，不再是 2013 版那套目录。
--
-- 目录来源：教习网（北师大版(2024) 四年级上册(2024) 课文目录）与多个新版教案交叉核对确认。
--
-- 幂等：先删掉教材自带的旧目录（is_custom=0）再重建；用户自建的（is_custom=1）一律保留。
-- 单元 id：u1..u12；课文 id：u<单元号>l<课号>

INSERT OR IGNORE INTO textbooks (id, name, sort, is_custom, created_at) VALUES
 ('b4a', '北师大版 四年级上册（2024新版）', 1, 0, datetime('now'));
UPDATE textbooks SET name = '北师大版 四年级上册（2024新版）' WHERE id = 'b4a';

-- 老库升级用：把没有教材归属的单元挂到北师版四上
UPDATE units SET textbook_id = 'b4a' WHERE textbook_id IS NULL OR textbook_id = '';

-- 清掉旧（2013 版）目录，只动教材自带的，不动家长自建的单元/课文
-- 注意两个条件都要加：按课文自己的 is_custom 过滤，否则挂在自带单元下的
-- 家长自建课文（如「一单元复习」）会被连带删掉 —— 踩过一次。
DELETE FROM lessons WHERE is_custom = 0
  AND unit_id IN (SELECT id FROM units WHERE textbook_id = 'b4a' AND is_custom = 0);
DELETE FROM units WHERE textbook_id = 'b4a' AND is_custom = 0;

INSERT OR IGNORE INTO units (id, textbook_id, name, sort, is_custom, created_at) VALUES
 ('u1',  'b4a', '一 认识更大的数',            1, 0, datetime('now')),
 ('u2',  'b4a', '综合实践 编码',              2, 0, datetime('now')),
 ('u3',  'b4a', '二 线与角',                  3, 0, datetime('now')),
 ('u4',  'b4a', '三 整数乘法（二）',          4, 0, datetime('now')),
 ('u5',  'b4a', '四 我们生活的空间（二）',    5, 0, datetime('now')),
 ('u6',  'b4a', '五 运算律',                  6, 0, datetime('now')),
 ('u7',  'b4a', '数学好玩',                   7, 0, datetime('now')),
 ('u8',  'b4a', '六 图形的奥秘',              8, 0, datetime('now')),
 ('u9',  'b4a', '七 运用数量关系解决问题',    9, 0, datetime('now')),
 ('u10', 'b4a', '八 数据的表示和分析',       10, 0, datetime('now')),
 ('u11', 'b4a', '综合实践 导航给的时间准吗', 11, 0, datetime('now')),
 ('u12', 'b4a', '总复习',                    12, 0, datetime('now'));

-- 一 认识更大的数
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u1l1','u1','数说祖国',        1,0,datetime('now')),
 ('u1l2','u1','十万有多大',      2,0,datetime('now')),
 ('u1l3','u1','认识更大的数',    3,0,datetime('now')),
 ('u1l4','u1','人口普查',        4,0,datetime('now')),
 ('u1l5','u1','大豆产量',        5,0,datetime('now')),
 ('u1l6','u1','国庆庆典',        6,0,datetime('now')),
 ('u1l7','u1','从结绳计数说起',  7,0,datetime('now')),
 ('u1l8','u1','整理与复习',      8,0,datetime('now'));

-- 综合实践 编码
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u2l1','u2','生活中的编码',    1,0,datetime('now')),
 ('u2l2','u2','编码的奥秘',      2,0,datetime('now')),
 ('u2l3','u2','设计编码方案',    3,0,datetime('now')),
 ('u2l4','u2','选手编码交流会',  4,0,datetime('now'));

-- 二 线与角
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u3l1','u3','线的认识',        1,0,datetime('now')),
 ('u3l2','u3','相交与垂直',      2,0,datetime('now')),
 ('u3l3','u3','平移与平行',      3,0,datetime('now')),
 ('u3l4','u3','旋转与角',        4,0,datetime('now')),
 ('u3l5','u3','角的度量（一）',  5,0,datetime('now')),
 ('u3l6','u3','角的度量（二）',  6,0,datetime('now')),
 ('u3l7','u3','整理与复习',      7,0,datetime('now'));

-- 三 整数乘法（二）
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u4l1','u4','找规律',          1,0,datetime('now')),
 ('u4l2','u4','队列表演（一）',  2,0,datetime('now')),
 ('u4l3','u4','队列表演（二）',  3,0,datetime('now')),
 ('u4l4','u4','卫星运行时间',    4,0,datetime('now')),
 ('u4l5','u4','神奇的计算工具',  5,0,datetime('now')),
 ('u4l6','u4','有趣的算式',      6,0,datetime('now')),
 ('u4l7','u4','电影院',          7,0,datetime('now')),
 ('u4l8','u4','整理与复习',      8,0,datetime('now'));

-- 四 我们生活的空间（二）
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u5l1','u5','观察的范围',      1,0,datetime('now')),
 ('u5l2','u5','天安门广场',      2,0,datetime('now'));

-- 五 运算律
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u6l1','u6','生态养殖',                  1,0,datetime('now')),
 ('u6l2','u6','加法交换律和乘法交换律',    2,0,datetime('now')),
 ('u6l3','u6','加法结合律',                3,0,datetime('now')),
 ('u6l4','u6','乘法结合律',                4,0,datetime('now')),
 ('u6l5','u6','乘法分配律',                5,0,datetime('now')),
 ('u6l6','u6','整理与复习',                6,0,datetime('now'));

-- 数学好玩
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u7l1','u7','数图形的学问',    1,0,datetime('now'));

-- 六 图形的奥秘
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u8l1','u8','切开立体图形',    1,0,datetime('now')),
 ('u8l2','u8','搭建立体大楼',    2,0,datetime('now')),
 ('u8l3','u8','翻滚正方体',      3,0,datetime('now'));

-- 七 运用数量关系解决问题
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u9l1','u9','总量与分量',          1,0,datetime('now')),
 ('u9l2','u9','单价、数量与总价',    2,0,datetime('now')),
 ('u9l3','u9','速度、时间与路程',    3,0,datetime('now')),
 ('u9l4','u9','相遇问题',            4,0,datetime('now'));

-- 八 数据的表示和分析
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u10l1','u10','同学的生日',        1,0,datetime('now')),
 ('u10l2','u10','获奖时的年龄',      2,0,datetime('now'));

-- 综合实践 导航给的时间准吗
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u11l1','u11','出行导航',      1,0,datetime('now')),
 ('u11l2','u11','模拟实验',      2,0,datetime('now')),
 ('u11l3','u11','实地研究',      3,0,datetime('now')),
 ('u11l4','u11','研究分享会',    4,0,datetime('now'));

-- 总复习
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u12l1','u12','数与代数',      1,0,datetime('now')),
 ('u12l2','u12','图形与几何',    2,0,datetime('now')),
 ('u12l3','u12','统计与概率',    3,0,datetime('now')),
 ('u12l4','u12','综合与实践',    4,0,datetime('now'));
