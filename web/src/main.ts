import ui from "@nuxt/ui/vue-plugin";
import { createApp } from "vue";
import {
  createRouter,
  createWebHashHistory,
  createWebHistory,
} from "vue-router";

import App from "./App.vue";
import AdminLayout from "./layouts/AdminLayout.vue";
import HomeView from "./views/HomeView.vue";
import IncidentsView from "./views/IncidentsView.vue";
import JobsView from "./views/JobsView.vue";
import MaintenancesView from "./views/MaintenancesView.vue";
import MonitorsView from "./views/MonitorsView.vue";
import NodeDetailView from "./views/NodeDetailView.vue";
import NodesView from "./views/NodesView.vue";
import NotFoundView from "./views/NotFoundView.vue";
import SettingsView from "./views/SettingsView.vue";

import "./main.css";

declare module "vue-router" {
  interface RouteMeta {
    requiresAuth?: boolean;
    loading?: "public" | "admin-cards" | "admin-list";
    hideIncidentBanner?: boolean;
  }
}

const router = createRouter({
  history:
    import.meta.env.VITE_DEMO === "true"
      ? createWebHashHistory()
      : createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    {
      path: "/",
      name: "public-status",
      component: HomeView,
      meta: { loading: "public" },
    },
    {
      path: "/admin",
      component: AdminLayout,
      meta: { requiresAuth: true, loading: "admin-list" },
      children: [
        { path: "", redirect: "/admin/nodes" },
        {
          path: "nodes",
          name: "nodes",
          component: NodesView,
          meta: { loading: "admin-cards" },
        },
        {
          path: "nodes/:id",
          name: "node-detail",
          component: NodeDetailView,
        },
        { path: "monitors", name: "monitors", component: MonitorsView },
        { path: "jobs", name: "jobs", component: JobsView },
        {
          path: "incidents",
          name: "incidents",
          component: IncidentsView,
          meta: { hideIncidentBanner: true },
        },
        {
          path: "maintenances",
          name: "maintenances",
          component: MaintenancesView,
        },
        { path: "settings", name: "settings", component: SettingsView },
      ],
    },
    {
      path: "/:pathMatch(.*)*",
      name: "not-found",
      component: NotFoundView,
      meta: { loading: "public" },
    },
  ],
});

const app = createApp(App);
app.use(router);
app.use(ui);
app.mount("#app");
