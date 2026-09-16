const nextConfig = {
  allowedDevOrigins: ["localhost", "127.0.0.1", "192.168.1.102"],
  async headers() {
    return [
      {
        source: "/chat/:path*",
        headers: [
          // Block the Screen Capture / getDisplayMedia API at the browser policy level
          {
            key: "Permissions-Policy",
            value: "display-capture=(), camera=(), microphone=(), screen-wake-lock=()",
          },
          // Prevent the page from being embedded (no iframe screenshots)
          { key: "X-Frame-Options", value: "DENY" },
          // Prevent MIME sniffing
          { key: "X-Content-Type-Options", value: "nosniff" },
          // No caching of chat pages
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
    ];
  },
};

export default nextConfig;
