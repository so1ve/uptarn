import ui from "@nuxt/ui/vue-plugin";
import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";

import App from "./App.vue";
import IncidentsView from "./views/IncidentsView.vue";
import JobsView from "./views/JobsView.vue";
import MaintenancesView from "./views/MaintenancesView.vue";
import MonitorsView from "./views/MonitorsView.vue";
import NodeDetailView from "./views/NodeDetailView.vue";
import NodesView from "./views/NodesView.vue";
import SettingsView from "./views/SettingsView.vue";

import "./main.css";

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    {
      path: "/",
      name: "public-status",
      component: { render: () => null },
    },
    { path: "/admin", name: "nodes", component: NodesView },
    {
      path: "/admin/nodes/:id",
      name: "node-detail",
      component: NodeDetailView,
    },
    { path: "/admin/monitors", name: "monitors", component: MonitorsView },
    { path: "/admin/jobs", name: "jobs", component: JobsView },
    { path: "/admin/incidents", name: "incidents", component: IncidentsView },
    {
      path: "/admin/maintenances",
      name: "maintenances",
      component: MaintenancesView,
    },
    { path: "/admin/settings", name: "settings", component: SettingsView },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

const app = createApp(App);
app.use(router);
app.use(ui);
app.mount("#app");
