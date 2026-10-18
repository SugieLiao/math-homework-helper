-- 北师大版（2024）小学数学四年级上册 · 教材目录
-- 幂等：INSERT OR IGNORE，重复执行不会重复插入
-- 单元 id：u1..u10；课文 id：u<单元号>l<课号>

INSERT OR IGNORE INTO textbooks (id, name, sort, is_custom, created_at) VALUES
 ('b4a', '北师大版 四年级上册', 1, 0, datetime('now'));

INSERT OR IGNORE INTO units (id, textbook_id, name, sort, is_custom, created_at) VALUES
 ('u1',  'b4a', '一 认识更大的数',   1, 0, datetime('now')),
 ('u2',  'b4a', '二 线与角',         2, 0, datetime('now')),
 ('u3',  'b4a', '三 乘法',           3, 0, datetime('now')),
 ('u4',  'b4a', '四 运算律',         4, 0, datetime('now')),
 ('u5',  'b4a', '五 方向与位置',     5, 0, datetime('now')),
 ('u6',  'b4a', '六 除法',           6, 0, datetime('now')),
 ('u7',  'b4a', '七 生活中的负数',   7, 0, datetime('now')),
 ('u8',  'b4a', '八 可能性',         8, 0, datetime('now')),
 ('u9',  'b4a', '数学好玩',          9, 0, datetime('now')),
 ('u10', 'b4a', '总复习',           10, 0, datetime('now'));

-- 老库升级用：把没有教材归属的单元挂到北师版四上
UPDATE units SET textbook_id = 'b4a' WHERE textbook_id IS NULL OR textbook_id = '';

-- 一 认识更大的数
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u1l1','u1','数一数',          1,0,datetime('now')),
 ('u1l2','u1','认识更大的数',    2,0,datetime('now')),
 ('u1l3','u1','人口普查',        3,0,datetime('now')),
 ('u1l4','u1','国土面积',        4,0,datetime('now')),
 ('u1l5','u1','近似数',          5,0,datetime('now')),
 ('u1l6','u1','从结绳计数说起',  6,0,datetime('now'));

-- 二 线与角
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u2l1','u2','线的认识',      1,0,datetime('now')),
 ('u2l2','u2','相交与垂直',    2,0,datetime('now')),
 ('u2l3','u2','平移与平行',    3,0,datetime('now')),
 ('u2l4','u2','旋转与角',      4,0,datetime('now')),
 ('u2l5','u2','角的度量（一）',5,0,datetime('now')),
 ('u2l6','u2','角的度量（二）',6,0,datetime('now'));

-- 三 乘法
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u3l1','u3','卫星运行时间',    1,0,datetime('now')),
 ('u3l2','u3','有多少名观众',    2,0,datetime('now')),
 ('u3l3','u3','神奇的计算工具',  3,0,datetime('now')),
 ('u3l4','u3','有趣的算式',      4,0,datetime('now'));

-- 四 运算律
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u4l1','u4','买文具',                  1,0,datetime('now')),
 ('u4l2','u4','加法交换律和乘法交换律',  2,0,datetime('now')),
 ('u4l3','u4','加法结合律',              3,0,datetime('now')),
 ('u4l4','u4','乘法结合律',              4,0,datetime('now')),
 ('u4l5','u4','乘法分配律',              5,0,datetime('now'));

-- 五 方向与位置
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u5l1','u5','去图书馆',  1,0,datetime('now')),
 ('u5l2','u5','确定位置',  2,0,datetime('now'));

-- 六 除法
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u6l1','u6','买文具（除数是整十数）', 1,0,datetime('now')),
 ('u6l2','u6','参观花圃',               2,0,datetime('now')),
 ('u6l3','u6','秋游',                   3,0,datetime('now')),
 ('u6l4','u6','商不变的规律',           4,0,datetime('now')),
 ('u6l5','u6','路程、时间与速度',       5,0,datetime('now'));

-- 七 生活中的负数
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u7l1','u7','温度',    1,0,datetime('now')),
 ('u7l2','u7','正负数',  2,0,datetime('now'));

-- 八 可能性
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u8l1','u8','不确定性',  1,0,datetime('now')),
 ('u8l2','u8','摸球游戏',  2,0,datetime('now'));

-- 数学好玩
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u9l1','u9','滴水实验',      1,0,datetime('now')),
 ('u9l2','u9','编码',          2,0,datetime('now')),
 ('u9l3','u9','数图形的学问',  3,0,datetime('now'));

-- 总复习
INSERT OR IGNORE INTO lessons (id, unit_id, name, sort, is_custom, created_at) VALUES
 ('u10l1','u10','数与代数',    1,0,datetime('now')),
 ('u10l2','u10','图形与几何',  2,0,datetime('now')),
 ('u10l3','u10','统计与概率',  3,0,datetime('now'));
