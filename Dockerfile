# Gunakan Node LTS yang stabil dan ringan
FROM node:20-alpine

# Set folder kerja di dalam container
WORKDIR /app

# Copy package management duluan biar instalasi cached dan cepat
COPY package*.json ./

# Install dependencies secara bersih
RUN npm install

# Copy seluruh kodingan proyek lu (termasuk folder public/models dan src)
COPY . .

# Ekspos port default Vite
EXPOSE 5173

# Jalankan aplikasi dengan flag --host biar bisa diakses dari luar container
CMD ["npm", "run", "dev", "--", "--host"]