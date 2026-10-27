# Cuboid Track 🎯

Hệ thống web báo cáo tiến độ hàng ngày cho team thực tập sinh, kiểm tra KPI và trạng thái nộp báo cáo.

## 1. Tính năng cốt lõi
- **Member (Intern):**
  - Nhập báo cáo tiến độ hàng ngày (Việc đã làm, vướng mắc, kế hoạch tiếp theo).
  - Tự động nhận diện hạn chót (17:30 GMT+7) và gắn cờ Đúng hạn / Nộp trễ.
  - Lưu danh tính bằng `localStorage`, không cần gõ lại tên mỗi lần vào web. Có nút đổi tài khoản nhanh.
  - Xem nhận xét và trạng thái KPI do Leader chấm (`Đạt`, `Cần cải thiện`, `Chưa đạt`).
- **Leader:**
  - Bảo vệ bằng mã PIN (`LEADER_PIN`, mặc định `123456`).
  - Xem danh sách báo cáo chi tiết theo ngày đã chọn.
  - Thống kê nhanh: Tổng intern, Đã nộp đúng hạn, Nộp trễ, Chưa nộp.
  - Đánh giá KPI và gửi feedback trực tiếp.
  - Thêm thực tập sinh mới vào hệ thống.

## 2. Công nghệ
- **Backend / Routing:** Hono chạy trên Cloudflare Pages Functions (TypeScript).
- **Database:** Cloudflare D1 (Serverless SQLite miễn phí).
- **UI:** Server-side rendered HTML + Tailwind CSS CDN (không cần bundle React nặng).
- **CI/CD:** GitHub Actions tự động test và deploy lên Cloudflare Pages khi push lên nhánh `main`.

## 3. Chạy cục bộ (Local Development)

```bash
# 1. Cài đặt dependencies
npm install

# 2. Khởi tạo database D1 local
npm run d1:init:local

# 3. Chạy dev server
npm run dev
```

Mở trình duyệt:
- Giao diện Member: `http://localhost:8788/`
- Giao diện Leader: `http://localhost:8788/leader` (Mã PIN mặc định: `123456`)

## 4. Chạy kiểm thử

```bash
node test/check.mjs
```

## 5. Triển khai Cloudflare (Production)

### Cách 1: Nối Git trực tiếp trên Cloudflare Dashboard (Khuyên dùng)
1. Đăng nhập [Cloudflare Dashboard](https://dash.cloudflare.com/) > **Workers & Pages** > **Create application** > **Pages** > **Connect to Git**.
2. Chọn repo `duongphamvin/cuboid-track`.
3. Cấu hình build:
   - Framework preset: `None`
   - Build command: *(để trống)*
   - Build output directory: `public`
4. Tạo D1 Database:
   - Vào mục **D1** trên Cloudflare, bấm **Create database** đặt tên `cuboid-track-db`.
   - Vào Settings của Pages project vừa tạo > **Functions** > **D1 Database Bindings** > Thêm binding:
     - Variable name: `DB`
     - D1 Database: chọn `cuboid-track-db`
   - Khởi tạo bảng cho remote:
     ```bash
     npx wrangler d1 execute cuboid-track-db --remote --file=./schema.sql
     ```
5. Đặt biến môi trường (Environment Variables) trong Pages:
   - `LEADER_PIN`: Mã PIN bảo vệ trang Leader (VD: `888999`).
